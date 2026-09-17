import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv.js';

describe('parseCsv', () => {
  it('splits records and fields, with either line ending and a trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });

  it('honours quotes: commas, newlines and doubled quotes inside a field', () => {
    expect(parseCsv('"x, y","line\none","say ""hi"""\n')).toEqual([
      ['x, y', 'line\none', 'say "hi"'],
    ]);
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('drops a leading byte-order mark and nothing else', () => {
    expect(parseCsv('﻿Name,Tags\n')).toEqual([['Name', 'Tags']]);
  });

  it('treats a quote after the field has started as a character', () => {
    expect(parseCsv('5" tall,x\n')).toEqual([['5" tall', 'x']]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n')).toEqual([['']]);
  });
});
