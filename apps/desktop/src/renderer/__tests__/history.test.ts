import { describe, expect, it } from 'vitest';

import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  canStep,
  currentEntry,
  step,
  stepCandidates,
  visit,
  type History,
} from '../history.js';

/** Every page is still there. */
const live: (id: string) => boolean = () => true;

/** The pages opened in this order, the last one open. */
function opened(...ids: string[]): History {
  return ids.reduce((history, id) => visit(history, id), EMPTY_HISTORY);
}

/** A step that must go somewhere. */
function moved(history: History, direction: 'back' | 'forward', isLive = live): History {
  const next = step(history, direction, isLive);
  if (next === undefined) throw new Error(`nowhere to go ${direction}`);
  return next;
}

describe('the pages opened, for Back and Forward', () => {
  it('starts with nothing open and nowhere to go', () => {
    expect(currentEntry(EMPTY_HISTORY)).toBeUndefined();
    expect(step(EMPTY_HISTORY, 'back', live)).toBeUndefined();
    expect(step(EMPTY_HISTORY, 'forward', live)).toBeUndefined();
  });

  it('puts each page opened on the end, and that page is the one open', () => {
    const history = opened('a', 'b', 'c');
    expect(history.entries).toEqual(['a', 'b', 'c']);
    expect(currentEntry(history)).toBe('c');
  });

  it('goes back twice from C to A, then forward to B', () => {
    const atA = moved(moved(opened('a', 'b', 'c'), 'back'), 'back');
    expect(currentEntry(atA)).toBe('a');
    expect(canStep(atA, 'back', live)).toBe(false);
    const atB = moved(atA, 'forward');
    expect(currentEntry(atB)).toBe('b');
    expect(atB.entries).toEqual(['a', 'b', 'c']);
  });

  it('has nowhere to go forward from the page opened last', () => {
    expect(step(opened('a', 'b'), 'forward', live)).toBeUndefined();
    expect(canStep(opened('a', 'b'), 'back', live)).toBe(true);
  });

  it('drops the pages ahead when a page is opened after going back', () => {
    const history = visit(moved(moved(opened('a', 'b', 'c'), 'back'), 'back'), 'd');
    expect(history.entries).toEqual(['a', 'd']);
    expect(currentEntry(history)).toBe('d');
    expect(canStep(history, 'forward', live)).toBe(false);
  });

  it('ignores opening the page already open, keeping what is ahead', () => {
    const history = opened('a', 'b', 'b');
    expect(history.entries).toEqual(['a', 'b']);
    const back = moved(opened('a', 'b', 'c'), 'back');
    expect(visit(back, 'b')).toBe(back);
    expect(canStep(visit(back, 'b'), 'forward', live)).toBe(true);
  });

  it('keeps a page opened again later, not straight after itself', () => {
    expect(opened('a', 'b', 'a').entries).toEqual(['a', 'b', 'a']);
  });

  it('steps over a page that is gone, both ways', () => {
    const gone = (id: string): boolean => id !== 'b';
    const atA = moved(opened('a', 'b', 'c'), 'back', gone);
    expect(currentEntry(atA)).toBe('a');
    expect(currentEntry(moved(atA, 'forward', gone))).toBe('c');
  });

  it('keeps a page that is gone, so it is back once restored', () => {
    const atA = moved(opened('a', 'b', 'c'), 'back', (id) => id !== 'b');
    expect(atA.entries).toEqual(['a', 'b', 'c']);
    expect(currentEntry(moved(atA, 'forward'))).toBe('b');
  });

  it('has nowhere to go when every page that way is gone', () => {
    const onlyC = (id: string): boolean => id === 'c';
    expect(step(opened('a', 'b', 'c'), 'back', onlyC)).toBeUndefined();
    expect(canStep(opened('a', 'b', 'c'), 'back', onlyC)).toBe(false);
  });

  it('steps over the page open now where it appears again', () => {
    // A, B, A: with B trashed, Back must not land on A and seem to do nothing.
    const history = opened('x', 'a', 'b', 'a');
    const atX = moved(history, 'back', (id) => id !== 'b');
    expect(currentEntry(atX)).toBe('x');
    expect(stepCandidates(history, 'back')).toEqual(['b', 'x']);
  });

  it('lists what a step would try, nearest first', () => {
    const atC = moved(opened('a', 'b', 'c', 'd'), 'back');
    expect(currentEntry(atC)).toBe('c');
    expect(stepCandidates(atC, 'back')).toEqual(['b', 'a']);
    expect(stepCandidates(atC, 'forward')).toEqual(['d']);
    expect(stepCandidates(EMPTY_HISTORY, 'back')).toEqual([]);
    expect(stepCandidates(EMPTY_HISTORY, 'forward')).toEqual([]);
  });

  it('forgets the oldest pages past the limit', () => {
    let history = EMPTY_HISTORY;
    for (let n = 0; n < HISTORY_LIMIT + 5; n++) history = visit(history, `p${String(n)}`);
    expect(history.entries).toHaveLength(HISTORY_LIMIT);
    expect(history.entries[0]).toBe('p5');
    expect(currentEntry(history)).toBe(`p${String(HISTORY_LIMIT + 4)}`);
    expect(HISTORY_LIMIT).toBe(100);
  });

  it('keeps the limit when a page is opened after going back', () => {
    const history = moved(opened('a', 'b', 'c'), 'back');
    const next = visit(history, 'd', 2);
    expect(next.entries).toEqual(['b', 'd']);
    expect(currentEntry(next)).toBe('d');
  });
});
