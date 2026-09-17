/**
 * The date texts a Notion CSV export contains, read without `Date.parse`.
 *
 * `Date.parse` is banned in packages/ (eslint.config.js): its grammar is
 * implementation-defined beyond ISO strings, and a zoneless day fed to it becomes an
 * instant in the machine's zone — which is exactly how "September 17" becomes September
 * 16 for anyone west of UTC (FORMAT.md section 10). These are hand-parsed and return the
 * calendar day and, when present, the wall-clock time; nothing here knows what zone the
 * export was made in, because the export does not say.
 *
 * Shapes seen in exports, all handled:
 *   September 17, 2026
 *   Sep 17, 2026
 *   September 17, 2026 3:05 PM
 *   September 17, 2026 15:05
 *   2026-09-17
 *   2026-09-17 15:05
 *   2026-09-17T15:05:00.000Z          (older exports)
 *   <any of the above> → <any of the above>   (a range; the start is kept)
 */

export interface ParsedDate {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Wall-clock time when the text had one. */
  time?: { hour: number; minute: number };
  /** True when the text was a range and only the start was kept. */
  range: boolean;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

function monthNumber(name: string): number | undefined {
  const lower = name.toLowerCase();
  for (const [full, number] of Object.entries(MONTHS)) {
    if (full === lower || (lower.length >= 3 && full.startsWith(lower))) return number;
  }
  return undefined;
}

function daysIn(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function calendar(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function clock(text: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(AM|PM)?Z?$/i.exec(text.trim());
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.toUpperCase();
  if (minute > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return undefined;
  }
  return { hour, minute };
}

function parseOne(text: string): Omit<ParsedDate, 'range'> | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  // ISO: 2026-09-17, 2026-09-17 15:05, 2026-09-17T15:05:00.000Z
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/.exec(trimmed);
  if (iso) {
    const date = calendar(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date === undefined) return undefined;
    if (iso[4] === undefined) return { date };
    const time = clock(iso[4]);
    return time === undefined ? undefined : { date, time };
  }

  // Month name: September 17, 2026 [3:05 PM]
  const named = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(.+))?$/.exec(trimmed);
  if (named) {
    const month = monthNumber(named[1] ?? '');
    if (month === undefined) return undefined;
    const date = calendar(Number(named[3]), month, Number(named[2]));
    if (date === undefined) return undefined;
    if (named[4] === undefined) return { date };
    const time = clock(named[4]);
    return time === undefined ? undefined : { date, time };
  }

  return undefined;
}

/** The day (and time) a Notion date cell means, or undefined when the text is not one. */
export function parseNotionDate(text: string): ParsedDate | undefined {
  const parts = text.split(/\s+(?:→|->)\s+/);
  const first = parts[0];
  if (first === undefined) return undefined;
  const start = parseOne(first);
  if (start === undefined) return undefined;
  if (parts.length > 1 && parts.slice(1).some((p) => parseOne(p) === undefined)) return undefined;
  return { ...start, range: parts.length > 1 };
}

/**
 * The instant a wall-clock time means in a zone, for the zones this importer can
 * offer: only UTC, because the export does not say which zone it was made in. Date.UTC
 * is arithmetic on a proleptic Gregorian calendar and reads no ambient state.
 */
export function utcInstant(date: string, time: { hour: number; minute: number }): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, time.hour, time.minute);
}
