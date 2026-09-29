/**
 * Dates typed in words, read against fixed todays so the tests do not depend on the clock.
 */
import type { CalendarDate } from '@knowtion/engine/properties';
import { describe, expect, it } from 'vitest';

import { readDateWords, type DateOrder, type DateWordsContext } from '../date-words.js';

/** Tuesday 29 September 2026. */
const TUESDAY = '2026-09-29' as CalendarDate;

function read(
  text: string,
  today: string = TUESDAY,
  order: DateOrder = 'mdy',
  weekStart = 1,
): string | undefined {
  const context: DateWordsContext = { today: today as CalendarDate, order, weekStart };
  const reading = readDateWords(text, context);
  if (reading === undefined) return undefined;
  return reading.complete ? reading.date : `${reading.date} (so far)`;
}

/** [typed, today, the date it means]. Month first, weeks from Monday. */
const WHOLE: [string, string, string][] = [
  // Month names, with or without a year; without one, this year even when it has passed.
  ['Oct 3', TUESDAY, '2026-10-03'],
  ['October 3', TUESDAY, '2026-10-03'],
  ['oct. 3rd', TUESDAY, '2026-10-03'],
  ['3 October', TUESDAY, '2026-10-03'],
  ['3rd of October', TUESDAY, '2026-10-03'],
  ['Oct 3 2027', TUESDAY, '2027-10-03'],
  ['Oct 3, 2027', TUESDAY, '2027-10-03'],
  ['3 Oct 2027', TUESDAY, '2027-10-03'],
  ['Oct 3 27', TUESDAY, '2027-10-03'],
  ['Sept 1', TUESDAY, '2026-09-01'],
  ['Jan 5', '2026-12-30', '2026-01-05'],
  // Year first, and numbers in the reader's order.
  ['2026-10-03', TUESDAY, '2026-10-03'],
  ['2027/1/5', TUESDAY, '2027-01-05'],
  ['10/3', TUESDAY, '2026-10-03'],
  ['10/3/2027', TUESDAY, '2027-10-03'],
  ['10-3-27', TUESDAY, '2027-10-03'],
  // Days in words.
  ['today', TUESDAY, '2026-09-29'],
  ['tomorrow', TUESDAY, '2026-09-30'],
  ['yesterday', TUESDAY, '2026-09-28'],
  ['in 3 days', TUESDAY, '2026-10-02'],
  ['in 2 weeks', TUESDAY, '2026-10-13'],
  ['in 1 month', TUESDAY, '2026-10-29'],
  ['3 days ago', TUESDAY, '2026-09-26'],
  ['2 years ago', TUESDAY, '2024-09-29'],
  ['next week', TUESDAY, '2026-10-06'],
  ['next month', TUESDAY, '2026-10-29'],
  ['next year', TUESDAY, '2027-09-29'],
  ['last week', TUESDAY, '2026-09-22'],
  // Weekdays: bare and "next" are the first one after today, "last" the one before.
  ['friday', TUESDAY, '2026-10-02'],
  ['next friday', TUESDAY, '2026-10-02'],
  ['fri', TUESDAY, '2026-10-02'],
  ['last friday', TUESDAY, '2026-09-25'],
  ['this friday', TUESDAY, '2026-10-02'],
  ['this monday', TUESDAY, '2026-09-28'],
  ['tuesday', TUESDAY, '2026-10-06'],
  ['last tue', TUESDAY, '2026-09-22'],
  // On the Friday itself.
  ['friday', '2026-10-02', '2026-10-09'],
  ['next friday', '2026-10-02', '2026-10-09'],
  ['last friday', '2026-10-02', '2026-09-25'],
  ['this friday', '2026-10-02', '2026-10-02'],
  // Across a year end.
  ['tomorrow', '2026-12-30', '2026-12-31'],
  ['in 3 days', '2026-12-30', '2027-01-02'],
  ['friday', '2026-12-30', '2027-01-01'],
  ['next month', '2026-12-30', '2027-01-30'],
  ['next year', '2026-12-30', '2027-12-30'],
  // A month too short for the day ends on its last one.
  ['next month', '2026-01-31', '2026-02-28'],
  ['in 1 month', '2026-01-31', '2026-02-28'],
  ['last month', '2026-01-31', '2025-12-31'],
  ['last week', '2026-01-31', '2026-01-24'],
  // 29 February.
  ['Feb 29', '2028-01-10', '2028-02-29'],
  ['Feb 29', TUESDAY, '2028-02-29'],
  ['29 February', TUESDAY, '2028-02-29'],
  ['2/29', TUESDAY, '2028-02-29'],
  ['next year', '2028-02-29', '2029-02-28'],
  ['last year', '2028-02-29', '2027-02-28'],
  ['tomorrow', '2028-02-28', '2028-02-29'],
];

describe('a date typed in words', () => {
  it.each(WHOLE)('"%s" on %s is %s', (text, today, date) => {
    expect(read(text, today)).toBe(date);
  });

  it('reads numbers in the order the reader writes them', () => {
    expect(read('10/3', TUESDAY, 'mdy')).toBe('2026-10-03');
    expect(read('10/3', TUESDAY, 'dmy')).toBe('2026-03-10');
    expect(read('3/10/2027', TUESDAY, 'dmy')).toBe('2027-10-03');
    expect(read('3.10.27', TUESDAY, 'dmy')).toBe('2027-10-03');
    // Year-first readers put the month before the day when there is no year.
    expect(read('10/3', TUESDAY, 'ymd')).toBe('2026-10-03');
    expect(read('2026/10/3', TUESDAY, 'ymd')).toBe('2026-10-03');
    // Four digits first are a year whatever the order.
    expect(read('2026-10-03', TUESDAY, 'dmy')).toBe('2026-10-03');
  });

  it('takes "this" to mean the week as the reader counts it', () => {
    expect(read('this sunday', TUESDAY, 'mdy', 1)).toBe('2026-10-04');
    expect(read('this sunday', TUESDAY, 'mdy', 0)).toBe('2026-09-27');
    expect(read('this saturday', TUESDAY, 'mdy', 0)).toBe('2026-10-03');
  });

  it('is nothing when the text is no date and cannot become one', () => {
    for (const text of [
      '',
      '   ',
      'hello',
      'zz',
      'Feb 30',
      'Oct 32',
      'Feb 29 2027',
      '13/1',
      'oct 3 foo',
      'friday!',
      'fr ',
      '9999 years ago',
    ]) {
      expect(read(text), text).toBeUndefined();
    }
    expect(read('31/1', TUESDAY, 'mdy')).toBeUndefined();
    expect(read('31/1', TUESDAY, 'dmy')).toBe('2026-01-31');
  });
});

describe('a date still being typed', () => {
  it('reads as the likeliest date it will be', () => {
    expect(read('Oc')).toBe('2026-10-01 (so far)');
    expect(read('Oct')).toBe('2026-10-01 (so far)');
    expect(read('Oct ')).toBe('2026-10-01 (so far)');
    expect(read('next f')).toBe('2026-10-02 (so far)');
    expect(read('next')).toBe('2026-10-06 (so far)');
    expect(read('next mont')).toBe('2026-10-29 (so far)');
    expect(read('la')).toBe('2026-09-22 (so far)');
    expect(read('th')).toBe('2026-10-01 (so far)');
    expect(read('in')).toBe('2026-09-30 (so far)');
    expect(read('in 3')).toBe('2026-10-02 (so far)');
    expect(read('in 2 w')).toBe('2026-10-13 (so far)');
    expect(read('3 days')).toBe('2026-09-26 (so far)');
    expect(read('2026-1')).toBe('2026-01-01 (so far)');
    expect(read('2026-10-')).toBe('2026-10-01 (so far)');
    expect(read('2026-10-0')).toBe('2026-10-01 (so far)');
    expect(read('Oct 3, 202')).toBe('2026-10-03 (so far)');
    expect(read('3/', TUESDAY, 'mdy')).toBe('2026-03-01 (so far)');
    expect(read('3/', TUESDAY, 'dmy')).toBe('2026-01-03 (so far)');
  });

  it('reads a whole word before the start of a longer one', () => {
    // "mon" is Monday already, though it may yet become "month".
    expect(read('next mon')).toBe('2026-10-05');
  });

  // The menu closes for good the first time a text reads as nothing, so every step of
  // typing a date has to read as something.
  it('never reads as nothing on the way to a date', () => {
    const starts = (text: string): string[] =>
      Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));
    for (const [text, today] of WHOLE) {
      for (const start of starts(text)) {
        expect(read(start, today), `"${start}", typing "${text}"`).toBeDefined();
      }
    }
    for (const text of ['3/10/2027', '3.10.27', '31/12', '29/2']) {
      for (const start of starts(text)) {
        expect(read(start, TUESDAY, 'dmy'), `"${start}", typing "${text}"`).toBeDefined();
      }
    }
  });
});
