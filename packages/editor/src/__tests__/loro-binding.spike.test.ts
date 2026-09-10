// @vitest-environment jsdom
/**
 * The spike ADR-0003 requires before any other code.
 *
 * loro-prosemirror is pre-1.0 and no Loro binding exists for Tiptap or Lexical, so
 * this integration is the one decision that could still force re-picking the CRDT.
 * These tests are the evidence, kept permanently as a regression suite.
 *
 * VERDICT: the binding works. Four behaviours discovered here shape everything built
 * on top, and each is pinned by a test below:
 *
 * 1. The CRDT-to-editor direction needs an EditorView. The plugin hydrates in its view
 *    lifecycle, so a headless EditorState never receives content. The engine must never
 *    depend on the binding to read document state.
 *
 * 2. INITIAL hydration is asynchronous, delivered on a macrotask — a microtask is not
 *    enough. Once an editor is initialised, subsequent remote updates apply
 *    synchronously on import. So the wait is needed when opening a document, not when
 *    receiving edits into an open one.
 *
 * 3. To open an existing document, import the snapshot BEFORE constructing the editor.
 *    Two editors that each initialise their own empty document and are then merged lose
 *    content: each creates its own root, and the merge keeps only one.
 *
 * 4. An edit dispatched before initialisation completes is absorbed into the base state
 *    and can never be undone.
 */
import { LoroDoc } from 'loro-crdt';
import { LoroSyncPlugin, LoroUndoPlugin, canUndo, redo, undo } from 'loro-prosemirror';
import { schema } from 'prosemirror-schema-basic';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';

const mounted: EditorView[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.destroy();
  document.body.innerHTML = '';
});

/** Let Loro's subscriptions fire. A microtask is not enough; see fact 2. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Open a document. Pass a snapshot to open an existing one: it must be imported
 * before the editor is constructed, per fact 3.
 */
function open(peerId: bigint, opts: { snapshot?: Uint8Array; undo?: boolean } = {}) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  if (opts.snapshot) doc.import(opts.snapshot);

  const el = document.createElement('div');
  document.body.appendChild(el);
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- pre-1.0 generic doc type */
  const plugins = [
    LoroSyncPlugin({ doc: doc as any }),
    ...(opts.undo ? [LoroUndoPlugin({ doc: doc })] : []),
  ];
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
  const view = new EditorView(el, { state: EditorState.create({ schema, plugins }) });
  mounted.push(view);

  return {
    doc,
    view,
    get text(): string {
      return view.state.doc.textContent;
    },
    type(text: string, pos: number): void {
      view.dispatch(view.state.tr.insertText(text, pos));
      doc.commit();
    },
    update(): Uint8Array {
      return doc.export({ mode: 'update' });
    },
    snapshot(): Uint8Array {
      return doc.export({ mode: 'snapshot' });
    },
  };
}

describe('editor to CRDT', () => {
  it('mirrors edits into the Loro document, synchronously', async () => {
    const a = open(1n);
    await settle();
    a.type('hello knowtion', 1);

    const json = JSON.stringify(a.doc.toJSON());
    expect(json).toContain('hello knowtion');
    // The shape the binding imposes: nested maps carrying nodeName and children.
    expect(json).toContain('"nodeName":"doc"');
    expect(json).toContain('"nodeName":"paragraph"');
  });
});

describe('CRDT to editor', () => {
  it('applies a remote update, but only after a macrotask', async () => {
    // Both devices share a base document, which is the only correct way to have two
    // editors on one document — see fact 3 and the two-roots test below.
    const a = open(1n);
    await settle();
    a.type('The quick ', 1);

    const b = open(2n, { snapshot: a.snapshot() });
    await settle();
    expect(b.text).toBe('The quick ');

    a.type('brown fox', 11);
    b.doc.import(a.update());

    // Once initialised, the editor is updated synchronously on import. No wait needed,
    // which is what makes incoming sync feel immediate rather than laggy.
    expect(b.text).toBe('The quick brown fox');
    expect(a.text).toBe(b.text);
  });

  it('initial hydration, by contrast, needs a macrotask', async () => {
    // The asymmetry that cost real time during the spike: opening a document is async,
    // receiving edits into an open one is not.
    const a = open(1n);
    await settle();
    a.type('seeded', 1);

    const b = open(2n, { snapshot: a.snapshot() });
    expect(b.text).toBe('');
    await Promise.resolve();
    expect(b.text).toBe(''); // a microtask is not enough
    await settle();
    expect(b.text).toBe('seeded');
  });

  it('two independently initialised documents must never be merged', async () => {
    // Each editor creates its own root on initialisation. Merging two of them keeps
    // only one root, silently discarding the other device's content. A device joining
    // a workspace MUST import a snapshot before constructing its editor.
    const a = open(1n);
    const b = open(2n);
    await settle();
    a.type('written on A', 1);
    b.type('written on B', 1);

    b.doc.import(a.update());
    await settle();

    // Not an assertion about which side wins — only that one side is lost. The point
    // is that this is silent, so the engine must make the pattern impossible.
    const survived = [b.text.includes('written on A'), b.text.includes('written on B')];
    expect(survived.filter(Boolean)).toHaveLength(1);
  });
});

describe('opening an existing document', () => {
  it('hydrates from a snapshot imported before the editor is constructed', async () => {
    const author = open(1n);
    await settle();
    author.type('original text', 1);

    const reader = open(2n, { snapshot: author.snapshot() });
    expect(reader.text).toBe(''); // not yet — see fact 2
    await settle();
    expect(reader.text).toBe('original text');
  });

  it('edits made after opening merge back to the author without loss', async () => {
    const author = open(1n);
    await settle();
    author.type('original text', 1);

    const other = open(2n, { snapshot: author.snapshot() });
    await settle();
    other.type('EDITED ', 1);

    author.doc.import(other.update());
    await settle();

    expect(author.text).toBe('EDITED original text');
    expect(other.text).toBe(author.text);
  });
});

describe('two devices editing concurrently', () => {
  it('converges and keeps both edits after offline changes', async () => {
    const seed = open(1n);
    await settle();
    seed.type('The quick brown fox', 1);
    const base = seed.snapshot();

    const a = open(2n, { snapshot: base });
    const b = open(3n, { snapshot: base });
    await settle();
    expect(a.text).toBe('The quick brown fox');
    expect(b.text).toBe('The quick brown fox');

    // Edits made while both are offline, at different positions.
    a.type('VERY ', 5);
    b.type(' jumps', 20);
    expect(a.text).not.toBe(b.text);

    // Exchange both ways, as folder-mode sync eventually does.
    const fromA = a.update();
    const fromB = b.update();
    a.doc.import(fromB);
    b.doc.import(fromA);
    await settle();

    expect(a.text).toBe(b.text);
    expect(a.text).toContain('VERY');
    expect(a.text).toContain('jumps');
  });

  it('re-importing the same update is a no-op, so at-least-once delivery is safe', async () => {
    // Folder mode has no delta feed and rescans directories, so a pack WILL be seen
    // more than once. Idempotent import is what makes that harmless.
    const a = open(1n);
    await settle();
    a.type('once', 1);
    const update = a.update();

    const b = open(2n, { snapshot: a.snapshot() });
    await settle();
    b.doc.import(update);
    b.doc.import(update);
    b.doc.import(update);
    await settle();

    expect(b.text).toBe('once');
  });
});

describe('undo scoping', () => {
  it('undoes only the local peer edits, never another device edits', async () => {
    // ADR-0003 flagged undo scoping as something we might have to own. LoroUndoPlugin
    // provides it, and this is the property that matters: pressing undo must never
    // revert something another device did.
    const seed = open(1n);
    await settle();
    seed.type('base ', 1);
    const base = seed.snapshot();

    const a = open(2n, { snapshot: base, undo: true });
    const b = open(3n, { snapshot: base, undo: true });
    await settle();

    a.type('mine ', 1);
    b.type('THEIRS ', 1);
    a.doc.import(b.update());
    await settle();

    expect(a.text).toContain('mine');
    expect(a.text).toContain('THEIRS');
    expect(canUndo(a.view.state)).toBe(true);
    expect(undo(a.view.state, a.view.dispatch)).toBe(true);
    await settle();

    // The other device's word survives; ours is gone. This is the whole point.
    expect(a.text).toContain('THEIRS');
    expect(a.text).not.toContain('mine');

    expect(redo(a.view.state, a.view.dispatch)).toBe(true);
    await settle();
    expect(a.text).toContain('mine');
    expect(a.text).toContain('THEIRS');
  });

  it('an edit dispatched before initialisation completes can never be undone', async () => {
    // A human cannot type faster than mount, but code can: anything that seeds content
    // programmatically — a template, an import, a "new page" default — must wait for
    // initialisation, or the user's first undo silently does nothing.
    const early = open(1n, { undo: true });
    early.type('typed too early', 1);
    await settle();
    expect(early.text).toBe('typed too early');
    expect(canUndo(early.view.state)).toBe(false);

    const proper = open(2n, { undo: true });
    await settle();
    proper.type('typed after init', 1);
    await settle();
    expect(canUndo(proper.view.state)).toBe(true);
  });
});
