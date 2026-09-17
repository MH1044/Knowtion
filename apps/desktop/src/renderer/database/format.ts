/**
 * Formatting and parsing for property cells. Pure, so it is tested without a DOM.
 *
 * Two of these exist because of FORMAT.md section 10's date rule. A `date` is a zoneless
 * calendar day and is displayed and edited as the `YYYY-MM-DD` string it is stored as —
 * never turned into a JavaScript Date, which would pin it to an instant and render it a
 * day early for anyone west of UTC. A `datetime` is an instant with a zone; converting
 * between it and the wall-clock text a `datetime-local` input holds needs the zone's
 * offset at that moment, which `Intl` can give without a library.
 */

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

/**
 * A number typed by a person, or undefined when it is not one.
 *
 * Grouping commas are accepted when they sit where thousands separators do; a lone comma
 * is not treated as a decimal point, because guessing the locale would guess wrong for
 * half the world. Non-finite results are refused, since the engine refuses them too.
 */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed === '') return undefined;
  const ungrouped = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)
    ? trimmed.replace(/,/g, '')
    : trimmed;
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(ungrouped)) return undefined;
  const value = Number(ungrouped);
  return Number.isFinite(value) ? value : undefined;
}

/** A calendar date, shown as stored. */
export function formatDate(date: string): string {
  return date;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function partsFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
}

/** The wall clock in a zone at an instant, as the pieces a `datetime-local` input wants. */
function wallClockAt(
  ms: number,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  const formatter = partsFormatter(zone);
  if (formatter === null) return undefined;
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const n = (key: string) => Number(parts[key]);
  const out = {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour'),
    minute: n('minute'),
  };
  return Object.values(out).every(Number.isFinite) ? out : undefined;
}

/** Minutes the zone is ahead of UTC at the instant. */
function offsetMinutesAt(ms: number, zone: string): number | undefined {
  const wall = wallClockAt(ms, zone);
  if (wall === undefined) return undefined;
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // Whole minutes; the formatter drops seconds, so compare at minute precision.
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** `YYYY-MM-DDTHH:MM` in the zone, which is what a `datetime-local` input holds. */
export function instantToWallTime(ms: number, zone: string): string {
  const wall = wallClockAt(ms, zone) ?? wallClockAt(ms, 'UTC');
  if (wall === undefined) return '';
  const two = (v: number) => String(v).padStart(2, '0');
  return `${String(wall.year).padStart(4, '0')}-${two(wall.month)}-${two(wall.day)}T${two(wall.hour)}:${two(wall.minute)}`;
}

/**
 * The instant a wall-clock text names in a zone, or undefined when it names none.
 *
 * Guess the instant as if the zone were UTC, read the zone's offset there, correct, and
 * read the offset once more: across a daylight-saving change the first offset can be the
 * wrong side of the gap. A time that does not exist (inside a spring-forward gap) lands
 * on the nearest real minute rather than being refused.
 */
export function wallTimeToInstant(wall: string, zone: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutesAt(guess, zone) ?? offsetMinutesAt(guess, 'UTC');
  if (first === undefined) return undefined;
  const corrected = guess - first * 60_000;
  const second = offsetMinutesAt(corrected, zone) ?? first;
  return second === first ? corrected : guess - second * 60_000;
}

/** A datetime for display: the wall clock in its own zone, with the zone named. */
export function formatDateTime(ms: number, zone: string): string {
  const wall = instantToWallTime(ms, zone);
  return wall === '' ? '' : `${wall.replace('T', ' ')} ${zone}`;
}

/** The zones a picker offers, with the platform's own zone first. */
export function zoneChoices(current: string): string[] {
  const known: string[] =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  const set = new Set([current, ...known]);
  if (!set.has('UTC')) set.add('UTC');
  return [...set];
}
