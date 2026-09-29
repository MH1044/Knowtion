/**
 * A date typed in words after `@`: "Oct 3", "3 October 2027", "10/3", "2026-10-03",
 * "next friday", "in 2 weeks", "3 days ago".
 *
 * Read by hand, in English, like the words the menu already offers. `Date.parse` is banned
 * in packages/ (its grammar is implementation-defined), and so is reading the clock, so
 * today comes in from the host.
 *
 * The `@` menu closes the moment it has nothing to offer, so a date has to be understood
 * while it is still being typed: "Oc" already reads as October 1st, "next f" as the coming
 * Friday. The reading is marked incomplete, and the menu places it after its own choices.
 * Text that no amount of further typing could turn into a date reads as nothing, and
 * closes the menu as before.
 */
import { addDays, isCalendarDate, type CalendarDate } from '@knowtion/engine/properties';

/** The order the reader writes a date in numbers: 10/3/2026, 3/10/2026 or 2026/10/3. */
export type DateOrder = 'mdy' | 'dmy' | 'ymd';

export interface DateWordsContext {
  today: CalendarDate;
  order: DateOrder;
  /** The day a week starts on, 0 for Sunday. "This friday" is the Friday of that week. */
  weekStart: number;
}

export interface DateReading {
  date: CalendarDate;
  /** False when the text is only the start of a date and `date` is its likeliest end. */
  complete: boolean;
}

interface Token {
  kind: 'word' | 'number' | 'mark';
  text: string;
  /** The last token, with nothing typed after it: the person may still be typing it. */
  open: boolean;
}

function tokenize(text: string): Token[] | undefined {
  const lower = text.toLowerCase();
  const pattern = /([a-z]+)|(\d+)|([/.,-])|(\s+)/y;
  const tokens: Token[] = [];
  let index = 0;
  while (index < lower.length) {
    pattern.lastIndex = index;
    const m = pattern.exec(lower);
    if (m === null) return undefined;
    index = pattern.lastIndex;
    if (m[4] !== undefined) continue;
    const kind = m[1] !== undefined ? 'word' : m[2] !== undefined ? 'number' : 'mark';
    tokens.push({ kind, text: m[0], open: false });
  }
  const last = tokens.at(-1);
  if (last !== undefined && !/\s$/.test(lower)) last.open = true;
  return tokens;
}

/**
 * How one token fits one place in a pattern. `whole` is false for the start of a word or a
 * number that could still become one; `value` is then the likeliest end, if there is one.
 */
interface Fit {
  value: number | undefined;
  whole: boolean;
}

interface Element {
  name: string;
  optional?: boolean;
  fit: (token: Token) => Fit | undefined;
}

/**
 * A word from a list, valued by its place in it. `short` is how many letters are enough
 * ("oct", "fri"); fewer, and it is only the start of the word.
 */
function words(name: string, list: readonly string[], short = Infinity, optional = false): Element {
  return {
    name,
    optional,
    fit: (token) => {
      if (token.kind !== 'word') return undefined;
      const index = list.findIndex((word) => word.startsWith(token.text));
      if (index < 0) return undefined;
      const exact = list.indexOf(token.text);
      if (exact >= 0) return { value: exact, whole: true };
      return { value: index, whole: token.text.length >= short };
    },
  };
}

function mark(name: string, marks: string, optional = false): Element {
  return {
    name,
    optional,
    fit: (token) =>
      token.kind === 'mark' && marks.includes(token.text) ? { value: 0, whole: true } : undefined,
  };
}

/** A number from `min` to `max` of at most `digits` digits, or the start of one. */
function number(name: string, min: number, max: number, digits: number): Element {
  return {
    name,
    fit: (token) => {
      if (token.kind !== 'number' || token.text.length > digits) return undefined;
      const value = Number(token.text);
      if (value >= min && value <= max) return { value, whole: true };
      if (!token.open) return undefined;
      // "0" may still become "03", and "202" become "2026".
      for (let more = 1; more <= digits - token.text.length; more++) {
        const low = value * 10 ** more;
        if (low <= max && low + 10 ** more - 1 >= min) return { value: undefined, whole: false };
      }
      return undefined;
    },
  };
}

/** A year of four digits, or two meaning this century ("27" is 2027). */
function year(optional: boolean): Element {
  return {
    name: 'year',
    optional,
    fit: (token) => {
      if (token.kind !== 'number') return undefined;
      const { length } = token.text;
      if (length === 4) return { value: Number(token.text), whole: true };
      if (length === 2) return { value: 2000 + Number(token.text), whole: true };
      return length < 4 && token.open ? { value: undefined, whole: false } : undefined;
    },
  };
}

const optional = (element: Element): Element => ({ ...element, optional: true });

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;
/** Monday first, so "s" reads as Saturday and "t" as Tuesday. Index 6 is Sunday. */
const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const month = words('month', MONTHS, 3);
const weekday = words('weekday', WEEKDAYS, 3);
const day = number('day', 1, 31, 2);
const monthNumber = number('month', 1, 12, 2);
const count = number('count', 0, 9999, 4);
const unit = words('unit', ['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']);
/** Days 0, weeks 1, months 2, years 3, as `shift` takes them; the unit list pairs each. */
const unitKind = (slots: Slots): number => Math.floor((slots.unit ?? 0) / 2);
const period = words('period', ['week', 'month', 'year']);
const ordinal = words('ordinal', ['st', 'nd', 'rd', 'th'], Infinity, true);
const separator = mark('separator', '/.-');
const word = (text: string, name = text): Element => words(name, [text]);

type Slots = Partial<Record<string, number>>;

interface Pattern {
  elements: readonly Element[];
  /** The date the filled places mean, or undefined when they mean none. */
  date: (slots: Slots, context: DateWordsContext) => CalendarDate | undefined;
}

interface Match {
  slots: Slots;
  complete: boolean;
}

/**
 * Every way the tokens fill a pattern from its start. The text may stop early, which leaves
 * the rest of the pattern empty and the match incomplete.
 */
function* matches(
  elements: readonly Element[],
  tokens: readonly Token[],
  e = 0,
  t = 0,
  slots: Slots = {},
  whole = true,
): Generator<Match> {
  if (t === tokens.length) {
    yield { slots, complete: whole && elements.slice(e).every((el) => el.optional === true) };
    return;
  }
  const element = elements[e];
  const token = tokens[t];
  if (element === undefined || token === undefined) return;
  if (element.optional === true) yield* matches(elements, tokens, e + 1, t, slots, whole);
  const fit = element.fit(token);
  if (fit === undefined || (!fit.whole && !token.open)) return;
  const filled = fit.value === undefined ? slots : { ...slots, [element.name]: fit.value };
  yield* matches(elements, tokens, e + 1, t + 1, filled, whole && fit.whole);
}

// ---- calendar arithmetic -------------------------------------------------------

function parts(date: CalendarDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

function calendar(y: number, m: number, d: number): CalendarDate | undefined {
  const text = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(text) ? text : undefined;
}

function daysInMonth(y: number, m: number): number {
  // Day 0 of the next month is this month's last day. Date.UTC is arithmetic, not the clock.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The same day some months on, or the month's last day when it is shorter (Jan 31 + 1). */
function addMonths(date: CalendarDate, months: number): CalendarDate | undefined {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return calendar(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 0 for Sunday, as Intl and the host number weekdays. */
function weekdayOf(date: CalendarDate): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Our Monday-first weekday index to the Sunday-is-0 numbering. */
const sundayFirst = (index: number): number => (index + 1) % 7;

/** Some days (kind 0), weeks (1), months (2) or years (3) on from today. */
function shift(today: CalendarDate, amount: number, kind: number): CalendarDate | undefined {
  if (kind === 0) return checked(addDays(today, amount));
  if (kind === 1) return checked(addDays(today, amount * 7));
  return addMonths(today, kind === 2 ? amount : amount * 12);
}

/** addDays writes years past 9999 with a sign, which is no calendar date. */
function checked(date: CalendarDate): CalendarDate | undefined {
  return isCalendarDate(date) ? date : undefined;
}

/**
 * A day and month in a year, or with no year this year. 29 February without a year is the
 * next one there is, rather than no date at all.
 */
function dated(
  y: number | undefined,
  m: number,
  d: number,
  today: CalendarDate,
): CalendarDate | undefined {
  if (y !== undefined) return calendar(y, m, d);
  const [thisYear] = parts(today);
  for (let later = 0; later < 8; later++) {
    const date = calendar(thisYear + later, m, d);
    if (date !== undefined) return date;
  }
  return undefined;
}

// ---- what can be typed -----------------------------------------------------------

function nextWeekday(today: CalendarDate, target: number): CalendarDate {
  return addDays(today, (target - weekdayOf(today) + 7) % 7 || 7);
}

function lastWeekday(today: CalendarDate, target: number): CalendarDate {
  return addDays(today, -((weekdayOf(today) - target + 7) % 7 || 7));
}

function thisWeekday(context: DateWordsContext, target: number): CalendarDate {
  const { today, weekStart } = context;
  const start = addDays(today, -((weekdayOf(today) - weekStart + 7) % 7));
  return addDays(start, (target - weekStart + 7) % 7);
}

const monthDay = (slots: Slots, context: DateWordsContext): CalendarDate | undefined =>
  dated(slots.year, (slots.month ?? 0) + 1, slots.day ?? 1, context.today);

const numeric = (slots: Slots, context: DateWordsContext): CalendarDate | undefined =>
  dated(slots.year, slots.month ?? 1, slots.day ?? 1, context.today);

/** A date in numbers, in the order the reader writes one. */
const NUMERIC: Record<DateOrder, readonly Element[]> = {
  mdy: [monthNumber, separator, day, optional(separator), year(true)],
  dmy: [day, separator, monthNumber, optional(separator), year(true)],
  // Year-first readers write the year first; without one, month comes before day.
  ymd: [monthNumber, separator, day],
};

/**
 * What can be typed, in the order a half-typed text is read: "n" is the start of "next
 * week" before it is November, and "3" a number date before it is "3 days ago".
 */
function patterns(order: DateOrder): Pattern[] {
  return [
    {
      elements: [words('relative', ['today', 'tomorrow', 'yesterday'])],
      date: (slots, { today }) => addDays(today, [0, 1, -1][slots.relative ?? 0] ?? 0),
    },
    {
      elements: [word('next'), period],
      date: (slots, { today }) => shift(today, 1, (slots.period ?? 0) + 1),
    },
    {
      elements: [word('last'), period],
      date: (slots, { today }) => shift(today, -1, (slots.period ?? 0) + 1),
    },
    {
      elements: [weekday],
      date: (slots, { today }) => nextWeekday(today, sundayFirst(slots.weekday ?? 0)),
    },
    {
      elements: [word('next'), weekday],
      date: (slots, { today }) =>
        slots.weekday === undefined ? undefined : nextWeekday(today, sundayFirst(slots.weekday)),
    },
    {
      elements: [word('last'), weekday],
      date: (slots, { today }) =>
        slots.weekday === undefined ? undefined : lastWeekday(today, sundayFirst(slots.weekday)),
    },
    {
      // "this" alone reads as today, the day of this week there is so far.
      elements: [word('this'), weekday],
      date: (slots, context) =>
        slots.weekday === undefined
          ? context.today
          : thisWeekday(context, sundayFirst(slots.weekday)),
    },
    {
      // Oct 3, Oct. 3rd, October 3 2027, Oct 3, 2027
      elements: [month, mark('dot', '.', true), day, ordinal, mark('comma', ',', true), year(true)],
      date: monthDay,
    },
    { elements: NUMERIC[order], date: numeric },
    {
      // 2026-10-03, and 2026/10/3 however the reader writes dates.
      elements: [number('year', 1000, 9999, 4), separator, monthNumber, separator, day],
      date: numeric,
    },
    {
      // 3 October, 3rd of October 2027
      elements: [
        day,
        ordinal,
        optional(word('of')),
        month,
        mark('dot', '.', true),
        mark('comma', ',', true),
        year(true),
      ],
      date: monthDay,
    },
    {
      elements: [word('in'), count, unit],
      date: (slots, { today }) => shift(today, slots.count ?? 1, unitKind(slots)),
    },
    {
      elements: [count, unit, word('ago')],
      date: (slots, { today }) => shift(today, -(slots.count ?? 1), unitKind(slots)),
    },
  ];
}

/**
 * The date `text` names, or, while it is still being typed, the likeliest one it will.
 * Undefined when the text is not a date and cannot become one.
 */
export function readDateWords(text: string, context: DateWordsContext): DateReading | undefined {
  const tokens = tokenize(text.trimStart());
  if (tokens === undefined || tokens.length === 0) return undefined;
  let partial: CalendarDate | undefined;
  for (const pattern of patterns(context.order)) {
    for (const match of matches(pattern.elements, tokens)) {
      const date = pattern.date(match.slots, context);
      if (date === undefined) continue;
      if (match.complete) return { date, complete: true };
      partial ??= date;
    }
  }
  return partial === undefined ? undefined : { date: partial, complete: false };
}
