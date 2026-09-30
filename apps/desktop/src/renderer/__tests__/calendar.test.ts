import { describe, expect, it } from 'vitest';

import type { CalendarDate } from '@knowtion/engine/properties';

import { openingMonth, placeCalendar, underRect } from '../Calendar.js';

const today = '2026-09-30' as CalendarDate;

describe('the month a calendar opens on', () => {
  it("is the date's own month", () => {
    expect(openingMonth('2027-01-15', today)).toEqual({ year: 2027, month: 1 });
    expect(openingMonth('1999-12-31', today)).toEqual({ year: 1999, month: 12 });
  });

  it('is this month for an empty date', () => {
    expect(openingMonth(undefined, today)).toEqual({ year: 2026, month: 9 });
    expect(openingMonth('', today)).toEqual({ year: 2026, month: 9 });
  });

  it('is this month for a value that is not a date', () => {
    expect(openingMonth('soon', today)).toEqual({ year: 2026, month: 9 });
    expect(openingMonth('2026-13-01', today)).toEqual({ year: 2026, month: 9 });
    expect(openingMonth('2026-9-1', today)).toEqual({ year: 2026, month: 9 });
  });
});

describe('where a calendar opens', () => {
  const viewport = { width: 1200, height: 800 };

  it('opens just under what opened it when there is room', () => {
    const cell = { left: 300, top: 200, bottom: 228 };
    expect(placeCalendar(underRect(cell), viewport)).toEqual({ left: 300, top: 232 });
  });

  it('opens above something near the bottom of the window', () => {
    const cell = { left: 300, top: 700, bottom: 728 };
    const placed = placeCalendar(underRect(cell), viewport);
    expect(placed.top).toBe(400);
    // Its 300px end above the cell rather than over it.
    expect(placed.top + 300).toBeLessThanOrEqual(cell.top);
  });

  it('stays inside the right edge, and below the top of a short window', () => {
    expect(placeCalendar(underRect({ left: 1100, bottom: 100 }), viewport).left).toBe(940);
    expect(placeCalendar(underRect({ left: 0, bottom: 100 }), { width: 400, height: 250 })).toEqual(
      { left: 0, top: 4 },
    );
  });

  it('is where the date chip already put it', () => {
    // The chip asks for its calendar at its box's bottom plus 4; the placement is unchanged.
    expect(placeCalendar({ left: 50, top: 104 }, viewport)).toEqual({ left: 50, top: 104 });
    expect(placeCalendar({ left: 50, top: 604 }, viewport)).toEqual({ left: 50, top: 272 });
  });
});
