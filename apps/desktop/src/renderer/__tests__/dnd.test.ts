import { describe, expect, it } from 'vitest';

import { cardMoveIsNoop, indexForPointer, positionForDrop } from '../database/dnd.js';

describe('positionForDrop', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('is a no-op when the row is dropped where it already is', () => {
    expect(positionForDrop(ids, 'b', 1)).toBeNull();
    // The slot just after itself is the same place once the mover is lifted out.
    expect(positionForDrop(ids, 'b', 2)).toBeNull();
  });

  it('places relative to the neighbour that will precede or follow it', () => {
    expect(positionForDrop(ids, 'd', 0)).toEqual({ kind: 'before', row: 'a' });
    expect(positionForDrop(ids, 'a', 4)).toEqual({ kind: 'after', row: 'd' });
    expect(positionForDrop(ids, 'a', 2)).toEqual({ kind: 'after', row: 'b' });
    expect(positionForDrop(ids, 'd', 1)).toEqual({ kind: 'after', row: 'a' });
    expect(positionForDrop(ids, 'c', 1)).toEqual({ kind: 'after', row: 'a' });
  });

  it('handles a mover from another list, which is in no slot yet', () => {
    expect(positionForDrop(ids, 'x', 0)).toEqual({ kind: 'before', row: 'a' });
    expect(positionForDrop(ids, 'x', 2)).toEqual({ kind: 'after', row: 'b' });
    expect(positionForDrop(ids, 'x', 4)).toEqual({ kind: 'after', row: 'd' });
    expect(positionForDrop([], 'x', 0)).toEqual({ kind: 'first' });
    expect(positionForDrop(['x'], 'x', 0)).toBeNull();
  });

  it('clamps an index past either end', () => {
    expect(positionForDrop(ids, 'x', 99)).toEqual({ kind: 'after', row: 'd' });
    expect(positionForDrop(ids, 'x', -3)).toEqual({ kind: 'before', row: 'a' });
  });
});

describe('indexForPointer', () => {
  const boxes: [number, number][] = [
    [0, 10],
    [10, 20],
    [20, 30],
  ];

  it('drops before the first row whose midpoint is below the pointer', () => {
    expect(indexForPointer(boxes, 2)).toBe(0);
    expect(indexForPointer(boxes, 5)).toBe(1);
    expect(indexForPointer(boxes, 14)).toBe(1);
    expect(indexForPointer(boxes, 16)).toBe(2);
    expect(indexForPointer(boxes, 29)).toBe(3);
    expect(indexForPointer([], 5)).toBe(0);
  });
});

describe('cardMoveIsNoop', () => {
  it('is true only when the column and the slot are both unchanged', () => {
    expect(cardMoveIsNoop('todo', 'todo', null)).toBe(true);
    expect(cardMoveIsNoop('todo', 'done', null)).toBe(false);
    expect(cardMoveIsNoop('todo', 'todo', { kind: 'first' })).toBe(false);
    expect(cardMoveIsNoop(null, null, null)).toBe(true);
    expect(cardMoveIsNoop(null, 'todo', null)).toBe(false);
  });
});
