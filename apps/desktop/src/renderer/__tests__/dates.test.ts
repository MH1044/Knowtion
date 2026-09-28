import { describe, expect, it } from 'vitest';

import { daysBetween, localToday, monthGrid, relativeLabel } from '../dates.js';

describe('dates for the reader', () => {
  it('reads today from the local calendar, not UTC', () => {
    expect(localToday(new Date(2026, 8, 28, 23, 59))).toBe('2026-09-28');
  });

  it('counts days across a month end and a daylight-saving change', () => {
    expect(daysBetween('2026-09-28', '2026-10-01')).toBe(3);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-01', '2026-09-28')).toBe(-3);
  });

  it('labels the nearest days in words and the rest as dates', () => {
    expect(relativeLabel('2026-09-28', '2026-09-28', 'en-US')).toBe('Today');
    expect(relativeLabel('2026-09-29', '2026-09-28', 'en-US')).toBe('Tomorrow');
    expect(relativeLabel('2026-09-27', '2026-09-28', 'en-US')).toBe('Yesterday');
    expect(relativeLabel('2026-10-03', '2026-09-28', 'en-US')).toBe('Oct 3');
    expect(relativeLabel('2027-01-05', '2026-09-28', 'en-US')).toBe('Jan 5, 2027');
  });
});

describe('the month grid', () => {
  it('is always six weeks, starting on the chosen weekday', () => {
    const weeks = monthGrid(2026, 9, 1);
    expect(weeks).toHaveLength(6);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 1 September 2026 is a Tuesday, so a Monday-first grid opens on 31 August.
    expect(weeks[0]?.[0]).toEqual({ date: '2026-08-31', inMonth: false });
    expect(weeks[0]?.[1]).toEqual({ date: '2026-09-01', inMonth: true });
  });

  it('starts on Sunday when asked', () => {
    expect(monthGrid(2026, 9, 0)[0]?.[0]?.date).toBe('2026-08-30');
  });

  it('holds every day of the month exactly once', () => {
    const days = monthGrid(2024, 2, 1)
      .flat()
      .filter((d) => d.inMonth);
    expect(days).toHaveLength(29);
    expect(days[28]?.date).toBe('2024-02-29');
  });
});
