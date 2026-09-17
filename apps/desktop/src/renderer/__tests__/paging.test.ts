import { describe, expect, it } from 'vitest';

import { clampPage, offsetOf, pageCount, rangeOf } from '../database/paging.js';

const SIZE = 500;

describe('pageCount', () => {
  it('is one for an empty table, so the label never reads "page 1 of 0"', () => {
    expect(pageCount(0, SIZE)).toBe(1);
    expect(pageCount(-3, SIZE)).toBe(1);
  });

  it('does not add a page for a total that divides exactly', () => {
    expect(pageCount(500, SIZE)).toBe(1);
    expect(pageCount(501, SIZE)).toBe(2);
    expect(pageCount(1000, SIZE)).toBe(2);
    expect(pageCount(1001, SIZE)).toBe(3);
  });

  it('survives a nonsense page size rather than dividing by zero', () => {
    expect(pageCount(100, 0)).toBe(1);
  });
});

describe('clampPage', () => {
  it('holds a page inside the range the row count has', () => {
    expect(clampPage(0, 1200, SIZE)).toBe(0);
    expect(clampPage(2, 1200, SIZE)).toBe(2);
    expect(clampPage(-1, 1200, SIZE)).toBe(0);
  });

  it('pulls a stranded page back when rows are deleted on another device', () => {
    // Someone was on page 3 of 3 when the rows behind it went away.
    expect(clampPage(2, 1200, SIZE)).toBe(2);
    expect(clampPage(2, 400, SIZE)).toBe(0);
    expect(clampPage(2, 600, SIZE)).toBe(1);
    expect(clampPage(5, 0, SIZE)).toBe(0);
  });
});

describe('offsetOf', () => {
  it('skips whole pages', () => {
    expect(offsetOf(0, SIZE)).toBe(0);
    expect(offsetOf(1, SIZE)).toBe(500);
    expect(offsetOf(3, SIZE)).toBe(1500);
  });

  it('never returns a negative offset', () => {
    expect(offsetOf(-2, SIZE)).toBe(0);
  });
});

describe('rangeOf', () => {
  it('numbers the rows a page covers from one', () => {
    expect(rangeOf(0, SIZE, 1200)).toEqual({ first: 1, last: 500 });
    expect(rangeOf(1, SIZE, 1200)).toEqual({ first: 501, last: 1000 });
    // The last page is short, and must not claim rows that are not there.
    expect(rangeOf(2, SIZE, 1200)).toEqual({ first: 1001, last: 1200 });
  });

  it('is empty when there is nothing to show', () => {
    expect(rangeOf(0, SIZE, 0)).toEqual({ first: 0, last: 0 });
  });

  it('reports the last real page when asked for one past the end', () => {
    expect(rangeOf(9, SIZE, 600)).toEqual({ first: 501, last: 600 });
  });
});
