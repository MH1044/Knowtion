import { describe, expect, it } from 'vitest';

import { canDrop, moveForDrop, zoneAt, type DropTargetPage } from '../tree-dnd.js';

const page = (id: string, parentId: string | undefined, index: number): DropTargetPage => ({
  id,
  parentId,
  index,
});

describe('zoneAt', () => {
  it('gives the middle half to nesting, which is what people reach for', () => {
    expect(zoneAt(0, 100, 50)).toBe('inside');
    expect(zoneAt(0, 100, 26)).toBe('inside');
    expect(zoneAt(0, 100, 74)).toBe('inside');
  });

  it('keeps a quarter at each edge for reordering', () => {
    expect(zoneAt(0, 100, 0)).toBe('before');
    expect(zoneAt(0, 100, 24)).toBe('before');
    expect(zoneAt(0, 100, 76)).toBe('after');
    expect(zoneAt(0, 100, 100)).toBe('after');
  });

  it('survives a row with no height rather than dividing by zero', () => {
    expect(zoneAt(50, 50, 50)).toBe('inside');
  });
});

describe('canDrop', () => {
  it('refuses a page onto itself', () => {
    expect(canDrop('a', page('a', undefined, 0), [])).toBe(false);
  });

  it('refuses a page into its own descendant, which the engine would reject as a cycle', () => {
    // Target 'grandchild' sits under 'child' under 'a'; dragging 'a' into it is a cycle.
    expect(canDrop('a', page('grandchild', 'child', 0), ['a', 'child'])).toBe(false);
  });

  it('allows an unrelated target', () => {
    expect(canDrop('a', page('b', undefined, 1), [])).toBe(true);
    expect(canDrop('a', page('grandchild', 'child', 0), ['b', 'child'])).toBe(true);
  });
});

describe('moveForDrop', () => {
  it('nests when dropped in the middle, with no position to give', () => {
    expect(moveForDrop(page('a', undefined, 0), page('b', undefined, 1), 'inside')).toEqual({
      parentId: 'b',
    });
  });

  it('places among the target siblings when dropped on an edge', () => {
    const dragged = page('x', 'p1', 0);
    expect(moveForDrop(dragged, page('b', 'p2', 2), 'before')).toEqual({
      parentId: 'p2',
      index: 2,
    });
    expect(moveForDrop(dragged, page('b', 'p2', 2), 'after')).toEqual({
      parentId: 'p2',
      index: 3,
    });
  });

  it('accounts for the dragged page being lifted out of its own list first', () => {
    // Moving the first child down past the third: once lifted, the third is at index 2.
    const dragged = page('a', 'p', 0);
    expect(moveForDrop(dragged, page('d', 'p', 3), 'after')).toEqual({ parentId: 'p', index: 3 });
    expect(moveForDrop(dragged, page('d', 'p', 3), 'before')).toEqual({ parentId: 'p', index: 2 });
  });

  it('does not shift when moving up within the same list', () => {
    const dragged = page('d', 'p', 3);
    expect(moveForDrop(dragged, page('a', 'p', 0), 'before')).toEqual({ parentId: 'p', index: 0 });
    expect(moveForDrop(dragged, page('a', 'p', 0), 'after')).toEqual({ parentId: 'p', index: 1 });
  });

  it('treats the top level as a parent like any other', () => {
    expect(moveForDrop(page('a', 'p', 0), page('b', undefined, 0), 'after')).toEqual({
      parentId: undefined,
      index: 1,
    });
  });
});
