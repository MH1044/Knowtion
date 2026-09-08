import { describe, expect, it } from 'vitest';
import { deterministicRuntime } from '../runtime.js';
import { WorkspaceError } from '../types.js';
import { Workspace } from '../workspace.js';

const ws = (seed = 1, peerId = 1n) =>
  Workspace.create({ runtime: deterministicRuntime(seed), peerId });

/** Titles of a tree level, for readable assertions. */
const titles = (pages: { title: string }[]) => pages.map((p) => p.title);

describe('creating pages', () => {
  it('creates a top-level page with sensible defaults', () => {
    const w = ws();
    const page = w.createPage();
    expect(page.title).toBe('Untitled');
    expect(page.parentId).toBeUndefined();
    expect(page.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.createdAt).toBeGreaterThan(0);
    expect(page.archivedAt).toBeUndefined();
  });

  it('nests pages arbitrarily deeply', () => {
    const w = ws();
    let parent = w.createPage({ title: 'level 0' });
    for (let depth = 1; depth <= 25; depth++) {
      parent = w.createPage({ parentId: parent.id, title: `level ${depth}` });
    }
    expect(w.allPages()).toHaveLength(26);

    let level = w.tree();
    for (let depth = 0; depth <= 25; depth++) {
      expect(level[0]!.title).toBe(`level ${depth}`);
      level = level[0]!.children;
    }
  });

  it('gives every page a distinct stable uuid', () => {
    const w = ws();
    const uuids = Array.from({ length: 200 }, () => w.createPage().uuid);
    expect(new Set(uuids).size).toBe(200);
  });
});

describe('reading the hierarchy', () => {
  it('lists children in insertion order', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Parent' });
    for (const title of ['One', 'Two', 'Three']) w.createPage({ parentId: parent.id, title });
    expect(titles(w.listChildren(parent.id))).toEqual(['One', 'Two', 'Three']);
  });

  it('reports an unknown id rather than returning undefined', () => {
    const w = ws();
    // Silent undefined is how a missing page becomes a blank screen with no explanation.
    expect(() => w.getPage('999@999')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(w.has('999@999')).toBe(false);
  });
});

describe('moving pages', () => {
  it('preserves identity, so links and open editors survive a move', () => {
    const w = ws();
    const home = w.createPage({ title: 'Home' });
    const work = w.createPage({ title: 'Work' });
    const note = w.createPage({ parentId: home.id, title: 'Note' });

    const moved = w.movePage(note.id, work.id);
    expect(moved.id).toBe(note.id);
    expect(moved.uuid).toBe(note.uuid);
    expect(moved.parentId).toBe(work.id);
    expect(titles(w.listChildren(home.id))).toEqual([]);
    expect(titles(w.listChildren(work.id))).toEqual(['Note']);
  });

  it('moves a page to the top level', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Parent' });
    const child = w.createPage({ parentId: parent.id, title: 'Child' });
    expect(w.movePage(child.id, undefined).parentId).toBeUndefined();
    expect(titles(w.tree())).toEqual(['Parent', 'Child']);
  });

  it('refuses to move a page beneath itself', () => {
    const w = ws();
    const page = w.createPage({ title: 'Self' });
    expect(() => w.movePage(page.id, page.id)).toThrowError(
      expect.objectContaining({ code: 'WOULD_CYCLE' }),
    );
  });

  it('refuses to move a page beneath its own descendant', () => {
    // The classic way a tree loses two subtrees at once. Rejected locally with a clear
    // error; the concurrent version of this is Loro's problem, not ours (ADR-0002).
    const w = ws();
    const root = w.createPage({ title: 'Root' });
    const mid = w.createPage({ parentId: root.id, title: 'Mid' });
    const leaf = w.createPage({ parentId: mid.id, title: 'Leaf' });

    for (const target of [mid.id, leaf.id]) {
      expect(() => w.movePage(root.id, target)).toThrowError(WorkspaceError);
    }
    // The tree is untouched by the rejected moves.
    expect(w.tree()[0]!.children[0]!.children[0]!.title).toBe('Leaf');
  });

  it('carries the whole subtree with the moved page', () => {
    const w = ws();
    const a = w.createPage({ title: 'A' });
    const b = w.createPage({ title: 'B' });
    const child = w.createPage({ parentId: a.id, title: 'Child' });
    w.createPage({ parentId: child.id, title: 'Grandchild' });

    w.movePage(child.id, b.id);
    const moved = w.tree().find((p) => p.title === 'B')!;
    expect(moved.children[0]!.title).toBe('Child');
    expect(moved.children[0]!.children[0]!.title).toBe('Grandchild');
  });
});

describe('trash', () => {
  it('archives instead of destroying, and restores', () => {
    const w = ws();
    const page = w.createPage({ title: 'Draft' });

    w.archivePage(page.id);
    expect(titles(w.tree())).toEqual([]); // hidden from the sidebar
    expect(titles(w.trash())).toEqual(['Draft']); // but recoverable
    expect(w.has(page.id)).toBe(true); // and still real

    w.restorePage(page.id);
    expect(titles(w.tree())).toEqual(['Draft']);
    expect(w.trash()).toEqual([]);
  });

  it('hides an archived page subtree from the sidebar without archiving the children', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Parent' });
    w.createPage({ parentId: parent.id, title: 'Child' });

    w.archivePage(parent.id);
    expect(w.tree()).toEqual([]);
    // The child is still there and still restorable with its parent.
    expect(w.allPages()).toHaveLength(2);
    w.restorePage(parent.id);
    expect(w.tree()[0]!.children[0]!.title).toBe('Child');
  });

  it('refuses to permanently delete a page that is not in the trash', () => {
    // Permanent deletion must be a deliberate second step, never a single misclick.
    const w = ws();
    const page = w.createPage({ title: 'Important' });
    expect(() => w.deletePage(page.id)).toThrowError(expect.objectContaining({ code: 'ARCHIVED' }));
    expect(w.has(page.id)).toBe(true);
  });

  it('permanently deletes an archived page and its subtree', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Parent' });
    w.createPage({ parentId: parent.id, title: 'Child' });

    w.archivePage(parent.id);
    w.deletePage(parent.id);

    expect(w.allPages()).toEqual([]);
    expect(w.has(parent.id)).toBe(false);
  });
});

describe('multi-device sync', () => {
  /** Two devices seeded from the same snapshot, which is the only safe way (ADR-0009). */
  function pair() {
    const origin = ws(1, 1n);
    const home = origin.createPage({ title: 'Home' });
    const snapshot = origin.snapshot();
    return {
      origin,
      home,
      a: Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n }),
      b: Workspace.open(snapshot, { runtime: deterministicRuntime(3), peerId: 3n }),
    };
  }

  const shape = (w: Workspace) =>
    w
      .allPages()
      .map((p) => `${p.title}<-${p.parentId ?? 'ROOT'}`)
      .sort();

  it('opens from a snapshot with the hierarchy intact', () => {
    const { a, b } = pair();
    expect(titles(a.tree())).toEqual(['Home']);
    expect(titles(b.tree())).toEqual(['Home']);
  });

  it('converges after both devices create pages offline', () => {
    const { a, b, home } = pair();
    a.createPage({ parentId: home.id, title: 'From A' });
    b.createPage({ parentId: home.id, title: 'From B' });

    const fromA = a.update();
    const fromB = b.update();
    a.merge(fromB);
    b.merge(fromA);

    expect(shape(a)).toEqual(shape(b));
    expect(titles(a.listChildren(home.id)).sort()).toEqual(['From A', 'From B']);
  });

  it('keeps no cycle when both devices reparent into each other', () => {
    // The failure ADR-0002 exists to prevent: A under B on one device, B under A on the
    // other. Both edits are individually valid and a naive tree loses both subtrees.
    const { a, b, home } = pair();
    const x = a.createPage({ parentId: home.id, title: 'X' });
    const y = a.createPage({ parentId: home.id, title: 'Y' });
    const seeded = a.update();
    b.merge(seeded);

    a.movePage(x.id, y.id);
    b.movePage(y.id, x.id);

    const fromA = a.update();
    const fromB = b.update();
    a.merge(fromB);
    b.merge(fromA);

    expect(shape(a)).toEqual(shape(b));
    // Nothing vanished, and the sidebar can still be walked without throwing.
    expect(a.allPages()).toHaveLength(3);
    expect(() => a.tree()).not.toThrow();
    expect(() => b.tree()).not.toThrow();
  });

  it('propagates a rename', () => {
    const { a, b, home } = pair();
    a.renamePage(home.id, 'Renamed on A');
    b.merge(a.update());
    expect(b.getPage(home.id).title).toBe('Renamed on A');
  });

  it('propagates archiving, so the trash is consistent across devices', () => {
    const { a, b, home } = pair();
    a.archivePage(home.id);
    b.merge(a.update());
    expect(titles(b.trash())).toEqual(['Home']);
    expect(b.tree()).toEqual([]);
  });

  it('propagates permanent deletion as a tombstone, not as an absence', () => {
    // FORMAT.md section 9: deletion must be an explicit operation. A page missing from
    // a listing means "I know less right now", never "this was deleted".
    const { a, b, home } = pair();
    a.archivePage(home.id);
    a.deletePage(home.id);
    b.merge(a.update());
    expect(b.allPages()).toEqual([]);
    expect(b.has(home.id)).toBe(false);
  });

  it('is idempotent, so at-least-once delivery from folder mode is safe', () => {
    const { a, b, home } = pair();
    a.createPage({ parentId: home.id, title: 'Once' });
    const update = a.update();

    b.merge(update);
    b.merge(update);
    b.merge(update);

    expect(titles(b.listChildren(home.id))).toEqual(['Once']);
  });

  it('converges regardless of the order updates arrive in', () => {
    // Folder mode has no ordering guarantee: packs are discovered by a directory scan.
    const { a, b, home } = pair();
    const c = Workspace.open(a.snapshot(), { runtime: deterministicRuntime(4), peerId: 4n });

    a.createPage({ parentId: home.id, title: 'A' });
    b.createPage({ parentId: home.id, title: 'B' });
    c.createPage({ parentId: home.id, title: 'C' });

    const updates = [a.update(), b.update(), c.update()];
    const forward = Workspace.open(a.snapshot(), { runtime: deterministicRuntime(5), peerId: 5n });
    const backward = Workspace.open(a.snapshot(), { runtime: deterministicRuntime(6), peerId: 6n });
    for (const u of updates) forward.merge(u);
    for (const u of [...updates].reverse()) backward.merge(u);

    expect(shape(forward)).toEqual(shape(backward));
  });
});
