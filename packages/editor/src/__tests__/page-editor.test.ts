// @vitest-environment jsdom
/**
 * The page editor as the application actually uses it.
 *
 * Complements the binding spike, which proved the library integration. These test our
 * own schema and the mount contract on top of it.
 */
import { LoroDoc } from 'loro-crdt';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';

import { mountPageEditor, schema } from '../index.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const editors: { destroy(): void }[] = [];

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  document.body.innerHTML = '';
});

function open(peerId: bigint, snapshot?: Uint8Array, onLocalChange?: (u: Uint8Array) => void) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = mountPageEditor({ element, peerId, snapshot, onLocalChange });
  editors.push(editor);
  return editor;
}

/** Parse an HTML fragment through the schema, as a clipboard paste would. */
function parseHtml(html: string) {
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return PMDOMParser.fromSchema(schema).parse(dom.body);
}

describe('schema', () => {
  it('has the v0.1 block types and no more', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([
      'blockquote',
      'bullet_list',
      'code_block',
      'divider',
      'doc',
      'heading',
      'list_item',
      'ordered_list',
      'paragraph',
      'text',
      'todo_item',
    ]);
  });

  it('parses pasted headings, lists and quotes into real blocks', () => {
    // The thing Notion clones visibly fail at: paste becomes a wall of paragraphs.
    const doc = parseHtml(
      '<h2>Title</h2><ul><li>one</li><li>two</li></ul><blockquote>q</blockquote>',
    );
    const types = doc.content.content.map((n) => n.type.name);
    expect(types).toEqual(['heading', 'bullet_list', 'blockquote']);
    expect(doc.content.content[0]!.attrs['level']).toBe(2);
  });

  it('folds heading levels deeper than three rather than dropping the block', () => {
    // Word and Docs emit h4 to h6. Dropping them would lose the user's structure.
    const doc = parseHtml('<h5>Deep</h5>');
    expect(doc.content.content[0]!.type.name).toBe('heading');
    expect(doc.content.content[0]!.attrs['level']).toBe(3);
    expect(doc.textContent).toBe('Deep');
  });

  it('keeps bold and italic through a paste from a word processor', () => {
    const doc = parseHtml('<p><b style="font-weight:bold">bold</b> and <i>italic</i></p>');
    const marks = new Set<string>();
    doc.descendants((node) => {
      for (const mark of node.marks) marks.add(mark.type.name);
    });
    expect(marks).toEqual(new Set(['strong', 'em']));
  });

  it('strips a javascript: link rather than storing it', () => {
    // An immutable log means an XSS sink pasted once is there forever, so the scheme
    // allowlist has to run at the parse boundary. See SECURITY.md.
    const doc = parseHtml('<p><a href="javascript:alert(1)">click</a></p>');
    const hrefs: unknown[] = [];
    doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === 'link') hrefs.push(mark.attrs['href']);
    });
    expect(hrefs).toEqual([]);
    expect(doc.textContent).toBe('click'); // the text survives, only the link is dropped
  });

  it('keeps an ordinary https link', () => {
    const doc = parseHtml('<p><a href="https://example.com">ok</a></p>');
    const hrefs: unknown[] = [];
    doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === 'link') hrefs.push(mark.attrs['href']);
    });
    expect(hrefs).toEqual(['https://example.com']);
  });
});

describe('mountPageEditor', () => {
  it('reports local edits as updates and not remote ones', async () => {
    const seen: Uint8Array[] = [];
    const editor = open(1n, undefined, (update) => seen.push(update));
    await settle();

    editor.view.dispatch(editor.view.state.tr.insertText('hello', 1));
    expect(seen.length).toBeGreaterThan(0);

    const before = seen.length;
    const other = new LoroDoc();
    other.setPeerId(2n);
    other.import(editor.snapshot());
    editor.applyRemote(other.export({ mode: 'update' }));
    await settle();
    // Applying a remote update must not echo straight back out as another write, or
    // two devices ping-pong updates at each other forever.
    expect(seen.length).toBe(before);
  });

  it('restores content from a snapshot', async () => {
    const author = open(1n);
    await settle();
    author.view.dispatch(author.view.state.tr.insertText('persisted text', 1));
    const snapshot = author.snapshot();

    const reader = open(2n, snapshot);
    await settle();
    expect(reader.view.state.doc.textContent).toBe('persisted text');
  });

  it('converges when two editors exchange updates', async () => {
    const a = open(1n);
    await settle();
    a.view.dispatch(a.view.state.tr.insertText('shared ', 1));

    const b = open(2n, a.snapshot());
    await settle();
    b.view.dispatch(b.view.state.tr.insertText('edited ', 1));

    a.applyRemote(b.doc.export({ mode: 'update' }));
    await settle();
    expect(a.view.state.doc.textContent).toBe(b.view.state.doc.textContent);
  });
});
