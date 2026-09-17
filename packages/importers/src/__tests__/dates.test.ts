import { describe, expect, it } from 'vitest';

import { parseNotionDate, utcInstant } from '../notion/dates.js';

describe('parseNotionDate', () => {
  it('reads the month-name shapes Notion writes', () => {
    expect(parseNotionDate('September 17, 2026')).toEqual({ date: '2026-09-17', range: false });
    expect(parseNotionDate('Sep 17, 2026')).toEqual({ date: '2026-09-17', range: false });
    expect(parseNotionDate('September 17, 2026 3:05 PM')).toEqual({
      date: '2026-09-17',
      time: { hour: 15, minute: 5 },
      range: false,
    });
    expect(parseNotionDate('September 17, 2026 12:30 AM')?.time).toEqual({ hour: 0, minute: 30 });
    expect(parseNotionDate('September 17, 2026 12:30 PM')?.time).toEqual({ hour: 12, minute: 30 });
  });

  it('reads ISO shapes, with or without a time', () => {
    expect(parseNotionDate('2026-09-17')).toEqual({ date: '2026-09-17', range: false });
    expect(parseNotionDate('2026-09-17 15:05')).toEqual({
      date: '2026-09-17',
      time: { hour: 15, minute: 5 },
      range: false,
    });
    expect(parseNotionDate('2026-09-17T15:05:00.000Z')?.time).toEqual({ hour: 15, minute: 5 });
  });

  it('keeps the start of a range and says it was one', () => {
    expect(parseNotionDate('September 17, 2026 → September 19, 2026')).toEqual({
      date: '2026-09-17',
      range: true,
    });
    expect(parseNotionDate('2026-09-17 09:00 -> 2026-09-17 10:00')?.range).toBe(true);
  });

  it('refuses text that is not a date, and impossible dates', () => {
    for (const text of [
      '',
      'tomorrow',
      'Septembruary 1, 2026',
      '2026-13-01',
      '2026-02-30',
      'February 29, 2027',
      'September 17, 2026 25:00',
      'September 17, 2026 13:00 PM',
      '17 September 2026',
      '2026-09-17 → soon',
    ]) {
      expect(parseNotionDate(text), text).toBeUndefined();
    }
    expect(parseNotionDate('February 29, 2028')).toEqual({ date: '2028-02-29', range: false });
  });

  it('turns a wall-clock time into a UTC instant by arithmetic alone', () => {
    expect(utcInstant('1970-01-01', { hour: 0, minute: 0 })).toBe(0);
    expect(utcInstant('2026-09-17', { hour: 15, minute: 5 })).toBe(Date.UTC(2026, 8, 17, 15, 5));
  });
});
