/**
 * Dates as the reader sees them: today where they are, and labels in their language.
 *
 * The editor cannot read the clock (CONTRIBUTING.md bans it under packages/), so this is
 * where today comes from. Values stay zoneless `YYYY-MM-DD` throughout, the same as a
 * database date property; only the labels depend on the reader.
 */
import type { CalendarDate } from '@knowtion/engine/properties';
import type { DateHost } from '@knowtion/editor';

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar date it is now, where this computer is. */
export function localToday(now = new Date()): CalendarDate {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` as CalendarDate;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** Local midnight of a calendar date, for formatting only. */
function asLocal(date: string): Date {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d);
}

/** Whole days from `from` to `to`. Counted in UTC so a daylight-saving change cannot skew it. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** "Today", "Tomorrow", "Yesterday", else a short date, with the year only when it differs. */
export function relativeLabel(date: string, today: string, locale?: string): string {
  const offset = daysBetween(today, date);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  const sameYear = parts(date)[0] === parts(today)[0];
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(asLocal(date));
}

/** A date in full: "Mon, Sep 28, 2026". */
export function describeDate(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(asLocal(date));
}

/** "September 2026". */
export function monthTitle(year: number, month: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  );
}

/** Short weekday names starting from `firstDay` (0 is Sunday). */
export function weekdayNames(firstDay: number, locale?: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    format.format(new Date(2023, 0, 1 + ((firstDay + i) % 7))),
  );
}

/** Which day a week starts on where the reader is, 0 for Sunday. Monday if unknown. */
export function firstDayOfWeek(locale = navigator.language): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    // Intl numbers Monday 1 to Sunday 7.
    return firstDay === undefined ? 1 : firstDay % 7;
  } catch {
    return 1;
  }
}

export interface GridDay {
  date: CalendarDate;
  inMonth: boolean;
}

/**
 * Six weeks covering a month, starting on `firstDay`. Always six, so the calendar does not
 * change height as the months go by.
 */
export function monthGrid(year: number, month: number, firstDay: number): GridDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() - firstDay + 7) % 7;
  const weeks: GridDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.UTC(year, month - 1, 1 - lead + w * 7 + d));
      week.push({
        date: day.toISOString().slice(0, 10) as CalendarDate,
        inMonth: day.getUTCMonth() === month - 1,
      });
    }
    weeks.push(week);
  }
  return weeks;
}

/** The editor's view of dates, for this reader. */
export function dateHost(): DateHost {
  return {
    today: () => localToday(),
    label: (date) => relativeLabel(date, localToday()),
    describe: (date) => describeDate(date),
  };
}
