/**
 * The semantic table both view interpreters are tested against.
 *
 * A fixture of eight properties and six rows, and a list of queries with the row order
 * each must produce. The JavaScript evaluator's test runs every case; the read model's
 * test projects the same rows into SQLite and runs the same cases through the SQL
 * compiler. A case added here is added to both, so a rule cannot quietly exist in one
 * interpreter only. That is the reason this lives in the package rather than in a test
 * directory: the read model is a different package and can only import what the engine
 * exports.
 *
 * Every expectation below is stated by hand from the rules in properties.ts and query.ts.
 * If a change to those rules is intended, the expectation changes here first.
 */

import { bytesToUuid } from './ids.js';
import type {
  CalendarDate,
  OptionId,
  PropertyDef,
  PropertyId,
  PropertyValue,
} from './properties.js';
import type { Filter, QueryContext, ViewSpec } from './query.js';

const uuid = (n: number) => bytesToUuid(new Uint8Array(16).fill(n));

export const CASE_OPTIONS = {
  RED: uuid(1),
  BLUE: uuid(2),
  GREEN: uuid(3),
  A: uuid(4),
  B: uuid(5),
} satisfies Record<string, OptionId>;

export const CASE_PROPERTIES = {
  TEXT: uuid(10),
  NUMBER: uuid(11),
  CHECKBOX: uuid(12),
  SELECT: uuid(13),
  MULTI: uuid(14),
  DATE: uuid(15),
  DATETIME: uuid(16),
  URL: uuid(17),
} satisfies Record<string, PropertyId>;

/** A property nobody defined, for the sanitising cases. */
export const CASE_MISSING_PROPERTY: PropertyId = uuid(99);

/** The view whose manual order some rows carry. */
export const CASE_VIEW = uuid(50);

const P = CASE_PROPERTIES;
const O = CASE_OPTIONS;

export const CASE_DEFS: PropertyDef[] = [
  { id: P.TEXT, name: 'Text', type: 'text', createdAt: 0, options: [] },
  { id: P.NUMBER, name: 'Number', type: 'number', createdAt: 0, options: [] },
  { id: P.CHECKBOX, name: 'Done', type: 'checkbox', createdAt: 0, options: [] },
  {
    id: P.SELECT,
    name: 'Colour',
    type: 'select',
    createdAt: 0,
    options: [
      { id: O.RED, name: 'Red' },
      { id: O.BLUE, name: 'Blue' },
      { id: O.GREEN, name: 'Green' },
    ],
  },
  {
    id: P.MULTI,
    name: 'Tags',
    type: 'multi-select',
    createdAt: 0,
    options: [
      { id: O.A, name: 'A' },
      { id: O.B, name: 'B' },
    ],
  },
  { id: P.DATE, name: 'Due', type: 'date', createdAt: 0, options: [] },
  { id: P.DATETIME, name: 'At', type: 'datetime', createdAt: 0, options: [] },
  { id: P.URL, name: 'Link', type: 'url', createdAt: 0, options: [] },
];

export interface CaseRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  properties?: Record<string, PropertyValue>;
  orderKeys?: Record<string, string>;
}

const day = (s: string) => s as CalendarDate;
/** 2026-01-10T23:30Z: the 10th in Los Angeles and UTC, already the 11th in Tokyo. */
const LATE_ON_THE_10TH = Date.UTC(2026, 0, 10, 23, 30);

/**
 * Six rows. Creation order is r1..r6. Titles are chosen so folded and raw orders differ;
 * r5 carries a value of the wrong kind under Text, which reads as empty.
 */
export const CASE_ROWS: CaseRow[] = [
  {
    id: 'r1',
    title: 'apple',
    createdAt: 1,
    updatedAt: 1,
    properties: {
      [P.TEXT]: { type: 'text', value: 'Hello World' },
      [P.NUMBER]: { type: 'number', value: 1 },
      [P.CHECKBOX]: { type: 'checkbox', value: true },
      [P.SELECT]: { type: 'select', value: O.RED },
      [P.MULTI]: { type: 'multi-select', value: [O.A] },
      [P.DATE]: { type: 'date', value: day('2026-01-10') },
      [P.DATETIME]: {
        type: 'datetime',
        value: { ms: LATE_ON_THE_10TH, zone: 'America/Los_Angeles' },
      },
      [P.URL]: { type: 'url', value: 'https://a.test' },
    },
    orderKeys: { [CASE_VIEW]: 'a1' },
  },
  {
    id: 'r2',
    title: 'Banana',
    createdAt: 2,
    updatedAt: 2,
    properties: {
      [P.TEXT]: { type: 'text', value: 'hello' },
      [P.NUMBER]: { type: 'number', value: 2.5 },
      [P.CHECKBOX]: { type: 'checkbox', value: false },
      [P.SELECT]: { type: 'select', value: O.BLUE },
      [P.MULTI]: { type: 'multi-select', value: [O.A, O.B] },
      [P.DATE]: { type: 'date', value: day('2026-01-11') },
      [P.DATETIME]: { type: 'datetime', value: { ms: LATE_ON_THE_10TH, zone: 'Asia/Tokyo' } },
    },
  },
  { id: 'r3', title: 'cherry', createdAt: 3, updatedAt: 3, orderKeys: { [CASE_VIEW]: 'a2' } },
  {
    id: 'r4',
    title: 'Émile',
    createdAt: 4,
    updatedAt: 4,
    properties: {
      [P.TEXT]: { type: 'text', value: 'Zebra' },
      [P.NUMBER]: { type: 'number', value: -1 },
      [P.CHECKBOX]: { type: 'checkbox', value: true },
      [P.SELECT]: { type: 'select', value: O.GREEN },
      [P.MULTI]: { type: 'multi-select', value: [O.B] },
      [P.DATE]: { type: 'date', value: day('2026-02-01') },
      [P.DATETIME]: { type: 'datetime', value: { ms: Date.UTC(2026, 1, 1), zone: 'UTC' } },
      [P.URL]: { type: 'url', value: 'http://z.test' },
    },
  },
  {
    id: 'r5',
    title: 'date',
    createdAt: 5,
    updatedAt: 5,
    properties: {
      // The wrong kind under a text property: a concurrent retype. Reads as empty.
      [P.TEXT]: { type: 'number', value: 5 },
      [P.NUMBER]: { type: 'number', value: 0 },
      [P.CHECKBOX]: { type: 'checkbox', value: false },
    },
  },
  {
    id: 'r6',
    title: 'eclair',
    createdAt: 6,
    updatedAt: 6,
    properties: {
      [P.TEXT]: { type: 'text', value: 'HELLO WORLD' },
      [P.NUMBER]: { type: 'number', value: 2.5 },
      [P.CHECKBOX]: { type: 'checkbox', value: false },
      [P.SELECT]: { type: 'select', value: O.RED },
      [P.DATE]: { type: 'date', value: day('2026-01-10') },
      [P.URL]: { type: 'url', value: 'https://a.test' },
    },
    orderKeys: { [CASE_VIEW]: 'a0' },
  },
];

export interface QueryCase {
  name: string;
  spec: ViewSpec;
  ctx?: QueryContext;
  /** Run with the manual order of CASE_VIEW when true. */
  inView?: boolean;
  /** Row ids in the order the interpreter must return them. */
  expected: string[];
  /** When grouping: each bucket's key and its rows, in bucket order. */
  expectedGroups?: [OptionId | null, string[]][];
  /** Warning codes the interpreter must report, in order. */
  expectedWarnings?: string[];
}

const UTC_LATE_10TH: QueryContext = { nowMs: LATE_ON_THE_10TH, timeZone: 'UTC' };

const filter = (expr: Filter, extra: Partial<ViewSpec> = {}): ViewSpec => ({
  sorts: [],
  filter: { v: 1, expr },
  ...extra,
});
const sorts = (...list: ViewSpec['sorts']): ViewSpec => ({ sorts: list });
const leaf = (property: PropertyId, op: string, value?: unknown): Filter =>
  ({ kind: 'leaf', property, op, ...(value === undefined ? {} : { value }) }) as Filter;

export const QUERY_CASES: QueryCase[] = [
  // ---- no filter -----------------------------------------------------------------
  {
    name: 'no filter, no sorts: creation order',
    spec: { sorts: [] },
    expected: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
  },
  {
    name: 'manual order of a view: keyed rows first by key, then unkeyed by creation',
    spec: { sorts: [] },
    inView: true,
    expected: ['r6', 'r1', 'r3', 'r2', 'r4', 'r5'],
  },

  // ---- text ------------------------------------------------------------------------
  {
    name: 'text equals is case-insensitive',
    spec: filter(leaf(P.TEXT, 'equals', 'hello world')),
    expected: ['r1', 'r6'],
  },
  {
    name: 'text contains is case-insensitive',
    spec: filter(leaf(P.TEXT, 'contains', 'ELL')),
    expected: ['r1', 'r2', 'r6'],
  },
  {
    name: 'text startsWith; a wrong-kind value is empty and does not match',
    spec: filter(leaf(P.TEXT, 'startsWith', 'z')),
    expected: ['r4'],
  },
  {
    name: 'text isEmpty includes absent and wrong-kind',
    spec: filter(leaf(P.TEXT, 'isEmpty')),
    expected: ['r3', 'r5'],
  },
  {
    name: 'url equals folds case too',
    spec: filter(leaf(P.URL, 'equals', 'HTTPS://A.TEST')),
    expected: ['r1', 'r6'],
  },

  // ---- number ----------------------------------------------------------------------
  { name: 'number gt', spec: filter(leaf(P.NUMBER, 'gt', 1)), expected: ['r2', 'r6'] },
  { name: 'number gte', spec: filter(leaf(P.NUMBER, 'gte', 1)), expected: ['r1', 'r2', 'r6'] },
  { name: 'number lt', spec: filter(leaf(P.NUMBER, 'lt', 0)), expected: ['r4'] },
  { name: 'number lte', spec: filter(leaf(P.NUMBER, 'lte', 0)), expected: ['r4', 'r5'] },
  { name: 'number eq', spec: filter(leaf(P.NUMBER, 'eq', 2.5)), expected: ['r2', 'r6'] },
  {
    name: 'number ne is not(eq): empty cells match',
    spec: filter(leaf(P.NUMBER, 'ne', 2.5)),
    expected: ['r1', 'r3', 'r4', 'r5'],
  },
  { name: 'number isEmpty', spec: filter(leaf(P.NUMBER, 'isEmpty')), expected: ['r3'] },

  // ---- checkbox --------------------------------------------------------------------
  { name: 'checkbox is true', spec: filter(leaf(P.CHECKBOX, 'is', true)), expected: ['r1', 'r4'] },
  {
    name: 'checkbox is false: absent means unchecked',
    spec: filter(leaf(P.CHECKBOX, 'is', false)),
    expected: ['r2', 'r3', 'r5', 'r6'],
  },

  // ---- select ----------------------------------------------------------------------
  {
    name: 'select optionIs',
    spec: filter(leaf(P.SELECT, 'optionIs', O.RED)),
    expected: ['r1', 'r6'],
  },
  {
    name: 'select optionIsNot is not(optionIs): empty cells match',
    spec: filter(leaf(P.SELECT, 'optionIsNot', O.RED)),
    expected: ['r2', 'r3', 'r4', 'r5'],
  },
  { name: 'select isEmpty', spec: filter(leaf(P.SELECT, 'isEmpty')), expected: ['r3', 'r5'] },
  {
    name: 'select operand naming a removed option matches nothing, with no warning',
    spec: filter(leaf(P.SELECT, 'optionIs', uuid(77))),
    expected: [],
  },

  // ---- multi-select ----------------------------------------------------------------
  {
    name: 'multi-select hasOption',
    spec: filter(leaf(P.MULTI, 'hasOption', O.A)),
    expected: ['r1', 'r2'],
  },
  {
    name: 'multi-select hasOption another',
    spec: filter(leaf(P.MULTI, 'hasOption', O.B)),
    expected: ['r2', 'r4'],
  },
  {
    name: 'multi-select lacksOption is not(hasOption): empty cells match',
    spec: filter(leaf(P.MULTI, 'lacksOption', O.A)),
    expected: ['r3', 'r4', 'r5', 'r6'],
  },
  {
    name: 'multi-select isEmpty',
    spec: filter(leaf(P.MULTI, 'isEmpty')),
    expected: ['r3', 'r5', 'r6'],
  },

  // ---- dates -------------------------------------------------------------------------
  {
    name: 'date onDate',
    spec: filter(leaf(P.DATE, 'onDate', { kind: 'on', date: '2026-01-10' })),
    expected: ['r1', 'r6'],
  },
  {
    name: 'date before',
    spec: filter(leaf(P.DATE, 'before', { kind: 'on', date: '2026-01-11' })),
    expected: ['r1', 'r6'],
  },
  {
    name: 'date after',
    spec: filter(leaf(P.DATE, 'after', { kind: 'on', date: '2026-01-10' })),
    expected: ['r2', 'r4'],
  },
  {
    name: 'date onOrBefore',
    spec: filter(leaf(P.DATE, 'onOrBefore', { kind: 'on', date: '2026-01-10' })),
    expected: ['r1', 'r6'],
  },
  {
    name: 'date onOrAfter',
    spec: filter(leaf(P.DATE, 'onOrAfter', { kind: 'on', date: '2026-01-11' })),
    expected: ['r2', 'r4'],
  },
  { name: 'date isEmpty', spec: filter(leaf(P.DATE, 'isEmpty')), expected: ['r3', 'r5'] },
  {
    name: "datetime onDate compares the calendar day in the value's own zone",
    spec: filter(leaf(P.DATETIME, 'onDate', { kind: 'on', date: '2026-01-10' })),
    expected: ['r1'],
  },
  {
    name: 'the same instant is the next day in Tokyo',
    spec: filter(leaf(P.DATETIME, 'onDate', { kind: 'on', date: '2026-01-11' })),
    expected: ['r2'],
  },
  {
    name: 'datetime after',
    spec: filter(leaf(P.DATETIME, 'after', { kind: 'on', date: '2026-01-10' })),
    expected: ['r2', 'r4'],
  },
  {
    name: "relative today resolves in the viewer's zone: Tokyo",
    spec: filter(leaf(P.DATE, 'onDate', { kind: 'relative', days: 0 })),
    ctx: { nowMs: LATE_ON_THE_10TH, timeZone: 'Asia/Tokyo' },
    expected: ['r2'],
  },
  {
    name: "relative today resolves in the viewer's zone: UTC",
    spec: filter(leaf(P.DATE, 'onDate', { kind: 'relative', days: 0 })),
    ctx: UTC_LATE_10TH,
    expected: ['r1', 'r6'],
  },
  {
    name: 'relative tomorrow',
    spec: filter(leaf(P.DATE, 'onDate', { kind: 'relative', days: 1 })),
    ctx: UTC_LATE_10TH,
    expected: ['r2'],
  },

  // ---- combinations ------------------------------------------------------------------
  {
    name: 'and',
    spec: filter({
      kind: 'and',
      clauses: [leaf(P.CHECKBOX, 'is', true), leaf(P.SELECT, 'optionIs', O.RED)],
    }),
    expected: ['r1'],
  },
  {
    name: 'or',
    spec: filter({
      kind: 'or',
      clauses: [leaf(P.NUMBER, 'lt', 0), leaf(P.TEXT, 'equals', 'hello')],
    }),
    expected: ['r2', 'r4'],
  },
  {
    name: 'not',
    spec: filter({ kind: 'not', clause: leaf(P.CHECKBOX, 'is', true) }),
    expected: ['r2', 'r3', 'r5', 'r6'],
  },
  {
    name: 'empty and matches everything',
    spec: filter({ kind: 'and', clauses: [] }),
    expected: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
  },
  { name: 'empty or matches nothing', spec: filter({ kind: 'or', clauses: [] }), expected: [] },

  // ---- sorts ---------------------------------------------------------------------------
  {
    name: 'sort title asc folds case; é sorts after e by code point',
    spec: sorts({ field: 'title', direction: 'asc' }),
    expected: ['r1', 'r2', 'r3', 'r5', 'r6', 'r4'],
  },
  {
    name: 'sort title desc',
    spec: sorts({ field: 'title', direction: 'desc' }),
    expected: ['r4', 'r6', 'r5', 'r3', 'r2', 'r1'],
  },
  {
    name: 'sort createdAt desc',
    spec: sorts({ field: 'createdAt', direction: 'desc' }),
    expected: ['r6', 'r5', 'r4', 'r3', 'r2', 'r1'],
  },
  {
    name: 'sort number asc: ties by creation, empties last',
    spec: sorts({ field: P.NUMBER, direction: 'asc' }),
    expected: ['r4', 'r5', 'r1', 'r2', 'r6', 'r3'],
  },
  {
    name: 'sort number desc: empties still last, ties still by creation',
    spec: sorts({ field: P.NUMBER, direction: 'desc' }),
    expected: ['r2', 'r6', 'r1', 'r5', 'r4', 'r3'],
  },
  {
    name: 'sort text asc: folded first, then raw by code point',
    spec: sorts({ field: P.TEXT, direction: 'asc' }),
    expected: ['r2', 'r6', 'r1', 'r4', 'r3', 'r5'],
  },
  {
    name: 'sort select asc by option position',
    spec: sorts({ field: P.SELECT, direction: 'asc' }),
    expected: ['r1', 'r6', 'r2', 'r4', 'r3', 'r5'],
  },
  {
    name: 'sort select desc',
    spec: sorts({ field: P.SELECT, direction: 'desc' }),
    expected: ['r4', 'r2', 'r1', 'r6', 'r3', 'r5'],
  },
  {
    name: 'sort date asc',
    spec: sorts({ field: P.DATE, direction: 'asc' }),
    expected: ['r1', 'r6', 'r2', 'r4', 'r3', 'r5'],
  },
  {
    name: 'sort datetime asc by instant',
    spec: sorts({ field: P.DATETIME, direction: 'asc' }),
    expected: ['r1', 'r2', 'r4', 'r3', 'r5', 'r6'],
  },
  {
    name: 'sort checkbox asc: unchecked first, absent is unchecked',
    spec: sorts({ field: P.CHECKBOX, direction: 'asc' }),
    expected: ['r2', 'r3', 'r5', 'r6', 'r1', 'r4'],
  },
  {
    name: 'sort checkbox desc',
    spec: sorts({ field: P.CHECKBOX, direction: 'desc' }),
    expected: ['r1', 'r4', 'r2', 'r3', 'r5', 'r6'],
  },
  {
    name: 'two sorts: checkbox asc then number desc',
    spec: sorts({ field: P.CHECKBOX, direction: 'asc' }, { field: P.NUMBER, direction: 'desc' }),
    expected: ['r2', 'r6', 'r5', 'r3', 'r1', 'r4'],
  },
  {
    name: 'a sort inside a view: sorts win, manual order breaks ties',
    spec: sorts({ field: P.CHECKBOX, direction: 'asc' }),
    inView: true,
    expected: ['r6', 'r3', 'r2', 'r5', 'r1', 'r4'],
  },

  // ---- grouping ----------------------------------------------------------------------
  {
    name: 'group by select: every option gets a bucket, no-value last, rows in view order',
    spec: { sorts: [], groupBy: P.SELECT },
    inView: true,
    expected: ['r6', 'r1', 'r3', 'r2', 'r4', 'r5'],
    expectedGroups: [
      [O.RED, ['r6', 'r1']],
      [O.BLUE, ['r2']],
      [O.GREEN, ['r4']],
      [null, ['r3', 'r5']],
    ],
  },
  {
    name: 'filter, sort and group together',
    spec: {
      sorts: [{ field: P.NUMBER, direction: 'asc' }],
      filter: { v: 1, expr: leaf(P.NUMBER, 'ne', 2.5) },
      groupBy: P.SELECT,
    },
    expected: ['r4', 'r5', 'r1', 'r3'],
    expectedGroups: [
      [O.RED, ['r1']],
      [O.BLUE, []],
      [O.GREEN, ['r4']],
      [null, ['r5', 'r3']],
    ],
  },

  // ---- degradation -------------------------------------------------------------------
  {
    name: 'a filter on a missing property is dropped whole, with a warning',
    spec: filter({
      kind: 'and',
      clauses: [leaf(P.CHECKBOX, 'is', true), leaf(CASE_MISSING_PROPERTY, 'isEmpty')],
    }),
    expected: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    expectedWarnings: ['UNKNOWN_PROPERTY'],
  },
  {
    name: 'an invalid sort is dropped alone; the valid one still applies',
    spec: sorts(
      { field: CASE_MISSING_PROPERTY, direction: 'asc' },
      { field: 'createdAt', direction: 'desc' },
    ),
    expected: ['r6', 'r5', 'r4', 'r3', 'r2', 'r1'],
    expectedWarnings: ['UNKNOWN_PROPERTY'],
  },
  {
    name: 'grouping on a non-select property ungroups with a warning',
    spec: { sorts: [], groupBy: P.TEXT },
    expected: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    expectedWarnings: ['UNGROUPABLE'],
  },
];
