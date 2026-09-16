/**
 * Typed property values: what a database cell holds, how it is stored, how it is read.
 *
 * FORMAT.md section 10.1 fixes the stored encodings and ADR-0014 explains them. Values are
 * stored UNTAGGED in the row's `props` map and decoded through the parent database's
 * schema, so changing a property's type never rewrites a value — a value of the old shape
 * simply becomes invisible until the type changes back. In memory the value is a tagged
 * union, so the read model, the query evaluator and the UI never have to consult the
 * schema to know whether a string is a date or a url.
 *
 * This module is also the single source of the semantics both view interpreters share:
 * emptiness, text folding, codepoint comparison, and the calendar date an instant falls on
 * in a zone. The SQL side stores the outputs of these functions at projection time; the JS
 * side calls them at evaluation time. Neither re-implements them.
 *
 * Nothing here consults the wall clock or ambient randomness, and validation never depends
 * on `Intl`: a value valid on one device must be valid on every other.
 */

import type { Uuid } from './ids.js';
import { WorkspaceError } from './types.js';

export const PROPERTY_TYPES = [
  'text',
  'number',
  'checkbox',
  'select',
  'multi-select',
  'date',
  'datetime',
  'url',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type PropertyId = Uuid;
export type OptionId = Uuid;
export type ViewId = Uuid;

/** A zoneless calendar date, `YYYY-MM-DD`, that has passed `isCalendarDate`. */
export type CalendarDate = string & { readonly __brand: 'calendarDate' };

/** An instant and the IANA zone it was entered in. The zone is display and calendar context. */
export interface DateTimeValue {
  ms: number;
  zone: string;
}

export type PropertyValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'checkbox'; value: boolean }
  | { type: 'select'; value: OptionId }
  | { type: 'multi-select'; value: OptionId[] }
  | { type: 'date'; value: CalendarDate }
  | { type: 'datetime'; value: DateTimeValue }
  | { type: 'url'; value: string };

export const OPTION_COLOURS = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type OptionColour = (typeof OPTION_COLOURS)[number];

export interface SelectOption {
  id: OptionId;
  name: string;
  color?: OptionColour;
}

export interface PropertyDef {
  id: PropertyId;
  name: string;
  type: PropertyType;
  createdAt: number;
  /** Always present; empty unless the type is select or multi-select. */
  options: SelectOption[];
}

export function isPropertyType(value: unknown): value is PropertyType {
  return typeof value === 'string' && (PROPERTY_TYPES as readonly string[]).includes(value);
}

export function isOptionColour(value: unknown): value is OptionColour {
  return typeof value === 'string' && (OPTION_COLOURS as readonly string[]).includes(value);
}

// ---- dates ---------------------------------------------------------------------

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `YYYY-MM-DD` naming a real day of the proleptic Gregorian calendar. Pure arithmetic. */
export function isCalendarDate(value: string): value is CalendarDate {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Syntactically an IANA zone name: `Area/Location`, with the characters the database
 * uses. Deliberately not a check against the platform's zone list — that would make a
 * value's validity depend on the writer's ICU data, so a device with a newer tz database
 * could write values an older one refuses.
 */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isZoneName(value: string): boolean {
  return value.length <= 64 && ZONE_NAME.test(value);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat | null>();

function dateFormatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = dateFormatters.get(zone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = null; // a zone this platform's ICU does not know
  }
  dateFormatters.set(zone, formatter);
  return formatter;
}

/**
 * The calendar date an instant falls on in a zone.
 *
 * This is what a datetime filter compares — "due today" is a question about the calendar
 * date in the value's own zone, not about instants. A zone this platform does not know
 * falls back to UTC, deterministically, so the SQL projection and the JS evaluator running
 * on the same machine cannot disagree; two machines with different tz data may, which
 * FORMAT.md section 10 calls correct behaviour rather than a conflict.
 */
export function localDateOf(ms: number, zone: string): CalendarDate {
  const formatter = dateFormatterFor(zone) ?? dateFormatterFor('UTC');
  const formatted = formatter?.format(new Date(ms)) ?? new Date(ms).toISOString().slice(0, 10);
  // en-CA formats as YYYY-MM-DD; years outside 1000..9999 would not, and are not calendar
  // dates this format accepts anyway.
  if (isCalendarDate(formatted)) return formatted;
  return new Date(ms).toISOString().slice(0, 10) as CalendarDate;
}

/** A calendar date some days later or earlier. Month and year ends roll over. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return shifted.toISOString().slice(0, 10) as CalendarDate;
}

// ---- text ----------------------------------------------------------------------

/** A lone surrogate half, which UTF-8 cannot carry and SQLite would therefore see differently. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace lone surrogates with U+FFFD, so JavaScript and UTF-8 storage agree on the text. */
export function toWellFormedText(text: string): string {
  return text.replace(LONE_SURROGATE, '�');
}

/**
 * The form text is compared in: well-formed, NFC, lower-cased.
 *
 * Equality and containment are case-insensitive by this folding; ordering uses the
 * folded form first and the raw form second. The SQL projection stores this beside the
 * raw value so the two interpreters compare the same bytes.
 */
export function foldText(text: string): string {
  return toWellFormedText(text).normalize('NFC').toLowerCase();
}

/**
 * Order two strings by code point, which is the order SQLite's BINARY collation gives
 * UTF-8. `localeCompare` would disagree with the database on the very first non-ASCII
 * character, and `<` on strings compares UTF-16 code units, which disagrees above U+FFFF.
 */
export function compareCodepoints(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

// ---- values --------------------------------------------------------------------

function invalid(def: PropertyDef, message: string): WorkspaceError {
  return new WorkspaceError('INVALID_VALUE', `property "${def.name}" (${def.type}): ${message}`);
}

function knownOption(def: PropertyDef, id: string): boolean {
  return def.options.some((option) => option.id === id);
}

/**
 * The stored form of a value, validated against the property, or undefined to clear it.
 *
 * Throws INVALID_VALUE when the value's tag does not match the property's type or the
 * payload is malformed. An empty text or url clears rather than stores, so "empty" and
 * "absent" are one state in the log.
 */
export function encodePropertyValue(def: PropertyDef, value: PropertyValue): unknown {
  if (value.type !== def.type) {
    throw invalid(def, `a ${value.type} value does not fit`);
  }
  switch (value.type) {
    case 'text':
    case 'url': {
      const text = toWellFormedText(value.value);
      return text === '' ? undefined : text;
    }
    case 'number':
      if (!Number.isFinite(value.value)) throw invalid(def, 'must be a finite number');
      return value.value === 0 ? 0 : value.value; // fold -0, which JSON cannot carry
    case 'checkbox':
      return value.value;
    case 'select':
      if (!knownOption(def, value.value)) throw invalid(def, `unknown option ${value.value}`);
      return value.value;
    case 'multi-select': {
      for (const id of value.value) {
        if (!knownOption(def, id)) throw invalid(def, `unknown option ${id}`);
      }
      // Deduplicated and in the schema's option order, so the stored form is canonical.
      const chosen = new Set(value.value);
      const ordered = def.options.filter((o) => chosen.has(o.id)).map((o) => o.id);
      return ordered.length === 0 ? undefined : ordered;
    }
    case 'date': {
      // Typed as a CalendarDate already, but a caller can cast; check the text anyway.
      const text: string = value.value;
      if (!isCalendarDate(text)) throw invalid(def, `${text} is not a calendar date`);
      return text;
    }
    case 'datetime': {
      const { ms, zone } = value.value;
      if (!Number.isSafeInteger(ms)) throw invalid(def, 'the instant must be a whole millisecond');
      if (!isZoneName(zone)) throw invalid(def, `${JSON.stringify(zone)} is not a zone name`);
      return { ms, zone };
    }
  }
}

/**
 * The in-memory value a stored form denotes under the property's current type, or
 * undefined when it does not fit — the possibly-absent convention every reader follows.
 *
 * A stored value is never rewritten or deleted here. A number under a property since
 * retyped to text reads as absent, and reads as itself again if the type changes back.
 * A select option that no longer exists reads as absent; unknown multi-select ids are
 * dropped from the array.
 */
export function decodePropertyValue(def: PropertyDef, raw: unknown): PropertyValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (def.type) {
    case 'text':
    case 'url':
      return typeof raw === 'string' && raw !== '' ? { type: def.type, value: raw } : undefined;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { type: 'number', value: raw }
        : undefined;
    case 'checkbox':
      return typeof raw === 'boolean' ? { type: 'checkbox', value: raw } : undefined;
    case 'select':
      return typeof raw === 'string' && knownOption(def, raw)
        ? { type: 'select', value: raw as OptionId }
        : undefined;
    case 'multi-select': {
      if (!Array.isArray(raw)) return undefined;
      const known = raw.filter(
        (id): id is OptionId => typeof id === 'string' && knownOption(def, id),
      );
      return known.length === 0 ? undefined : { type: 'multi-select', value: known };
    }
    case 'date':
      return typeof raw === 'string' && isCalendarDate(raw)
        ? { type: 'date', value: raw }
        : undefined;
    case 'datetime': {
      if (typeof raw !== 'object') return undefined;
      const { ms, zone } = raw as { ms?: unknown; zone?: unknown };
      if (typeof ms !== 'number' || !Number.isSafeInteger(ms)) return undefined;
      if (typeof zone !== 'string' || !isZoneName(zone)) return undefined;
      return { type: 'datetime', value: { ms, zone } };
    }
  }
}

/**
 * True when a cell holds nothing worth filtering or sorting on.
 *
 * Absent is empty. A value whose tag does not match the property is empty (a concurrent
 * retype). A checkbox is never empty: absent means unchecked.
 */
export function isEmptyValue(def: PropertyDef, value: PropertyValue | undefined): boolean {
  if (def.type === 'checkbox') return false;
  if (value?.type !== def.type) return true;
  switch (value.type) {
    case 'text':
    case 'url':
      return value.value === '';
    case 'number':
      return !Number.isFinite(value.value);
    case 'multi-select':
      return value.value.length === 0;
    default:
      return false;
  }
}

/**
 * A stable JSON fingerprint of a row's properties and order keys.
 *
 * The read model stores this beside the page row: when it has not changed, the row's
 * property tables are not rewritten. Keys are sorted so two equal rows always produce
 * the same text.
 */
export function canonicalRowJson(
  properties: Readonly<Record<string, PropertyValue>> | undefined,
  orderKeys: Readonly<Record<string, string>> | undefined,
): string {
  const sortedEntries = <T>(record: Readonly<Record<string, T>> | undefined): [string, T][] =>
    Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    p: Object.fromEntries(sortedEntries(properties)),
    o: Object.fromEntries(sortedEntries(orderKeys)),
  });
}
