/**
 * The query grammar: what a view may say, and how a spec that no longer fits degrades.
 *
 * The rules here are the ones both interpreters obey, so they are pinned once, here,
 * rather than discovered separately in the SQL and JS suites. The read-time rule is the
 * one most worth a test: a filter on a property another device deleted must lose the
 * whole filter with a warning, never hide rows silently.
 */
import { describe, expect, it } from 'vitest';

import { bytesToUuid } from '../ids.js';
import type {
  CalendarDate,
  OptionId,
  PropertyDef,
  PropertyId,
  PropertyType,
} from '../properties.js';
import {
  BUILTIN_FIELDS,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  OPS_BY_TYPE,
  QUERY_SPEC_VERSION,
  filterLeaves,
  parseFilter,
  parseStoredFilter,
  resolveDates,
  sanitiseSpec,
  stripProperty,
  validateSpec,
  type Filter,
  type FilterLeaf,
  type FilterOp,
  type ViewSpec,
} from '../query.js';

const id = (n: number) => bytesToUuid(new Uint8Array(16).fill(n));
const OPT: OptionId = id(1);
const MISSING: PropertyId = id(99);

function def(n: number, type: PropertyType, options: OptionId[] = []): PropertyDef {
  return {
    id: id(n),
    name: type,
    type,
    createdAt: 0,
    options: options.map((o) => ({ id: o, name: 'o' })),
  };
}

const TEXT = def(10, 'text');
const NUMBER = def(11, 'number');
const CHECK = def(12, 'checkbox');
const SELECT = def(13, 'select', [OPT]);
const MULTI = def(14, 'multi-select', [OPT]);
const DATE = def(15, 'date');
const DATETIME = def(16, 'datetime');
const URL = def(17, 'url');
const DEFS = [TEXT, NUMBER, CHECK, SELECT, MULTI, DATE, DATETIME, URL];

/** A well-formed leaf for an operator, on a property. */
function leaf(property: PropertyId, op: FilterOp): FilterLeaf {
  switch (op) {
    case 'isEmpty':
      return { kind: 'leaf', property, op };
    case 'equals':
    case 'contains':
    case 'startsWith':
      return { kind: 'leaf', property, op, value: 'x' };
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { kind: 'leaf', property, op, value: 1 };
    case 'is':
      return { kind: 'leaf', property, op, value: true };
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption':
      return { kind: 'leaf', property, op, value: OPT };
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter':
      return {
        kind: 'leaf',
        property,
        op,
        value: { kind: 'on', date: '2026-01-01' as CalendarDate },
      };
  }
}

const spec = (filter?: Filter, extra: Partial<ViewSpec> = {}): ViewSpec => ({
  sorts: [],
  ...(filter === undefined ? {} : { filter: { v: QUERY_SPEC_VERSION, expr: filter } }),
  ...extra,
});

const ALL_OPS = [...new Set(Object.values(OPS_BY_TYPE).flat())];

describe('the operator table', () => {
  it('every allowed (type, op) pair validates and every other pair is refused', () => {
    for (const d of DEFS) {
      for (const op of ALL_OPS) {
        const problems = validateSpec(DEFS, spec(leaf(d.id, op)));
        if (OPS_BY_TYPE[d.type].includes(op)) {
          expect(problems, `${d.type} ${op}`).toEqual([]);
        } else {
          expect(problems, `${d.type} ${op}`).toEqual([{ path: 'filter', code: 'OP_NOT_ALLOWED' }]);
        }
      }
    }
  });
});

describe('write-time validation', () => {
  it('names an unknown property, a bad operand and a stale option', () => {
    expect(validateSpec(DEFS, spec(leaf(MISSING, 'isEmpty')))).toEqual([
      { path: 'filter', code: 'UNKNOWN_PROPERTY' },
    ]);
    expect(
      validateSpec(DEFS, spec({ kind: 'leaf', property: NUMBER.id, op: 'gt', value: Number.NaN })),
    ).toEqual([{ path: 'filter', code: 'BAD_OPERAND' }]);
    expect(
      validateSpec(
        DEFS,
        spec({ kind: 'leaf', property: SELECT.id, op: 'optionIs', value: id(42) }),
      ),
    ).toEqual([{ path: 'filter', code: 'BAD_OPERAND' }]);
    expect(
      validateSpec(
        DEFS,
        spec({
          kind: 'leaf',
          property: DATE.id,
          op: 'after',
          value: { kind: 'relative', days: 1_000_000 },
        }),
      ),
    ).toEqual([{ path: 'filter', code: 'BAD_OPERAND' }]);
  });

  it('reports the path of a nested problem', () => {
    const filter: Filter = {
      kind: 'and',
      clauses: [leaf(TEXT.id, 'isEmpty'), { kind: 'not', clause: leaf(MISSING, 'isEmpty') }],
    };
    expect(validateSpec(DEFS, spec(filter))).toEqual([
      { path: 'filter.clauses[1].clause', code: 'UNKNOWN_PROPERTY' },
    ]);
  });

  it('refuses a filter from a newer grammar, so a client never rewrites what it cannot read', () => {
    const newer: ViewSpec = {
      sorts: [],
      filter: { v: QUERY_SPEC_VERSION + 1, expr: leaf(TEXT.id, 'isEmpty') },
    };
    expect(validateSpec(DEFS, newer)).toEqual([{ path: 'filter', code: 'UNSUPPORTED_VERSION' }]);
  });

  it('caps depth and leaf count', () => {
    let deep: Filter = leaf(TEXT.id, 'isEmpty');
    for (let i = 0; i < MAX_FILTER_DEPTH; i++) deep = { kind: 'not', clause: deep };
    expect(validateSpec(DEFS, spec(deep))).toEqual([{ path: 'filter', code: 'TOO_DEEP' }]);

    const wide: Filter = {
      kind: 'or',
      clauses: Array.from({ length: MAX_FILTER_LEAVES + 1 }, () => leaf(TEXT.id, 'isEmpty')),
    };
    expect(validateSpec(DEFS, spec(wide))).toEqual([{ path: 'filter', code: 'TOO_MANY_LEAVES' }]);
  });

  it('checks sorts and grouping against the schema', () => {
    expect(
      validateSpec(DEFS, {
        sorts: [
          { field: 'title', direction: 'asc' },
          { field: MULTI.id, direction: 'asc' },
          { field: MISSING, direction: 'desc' },
        ],
        groupBy: TEXT.id,
      }),
    ).toEqual([
      { path: 'sorts[1]', code: 'UNSORTABLE' },
      { path: 'sorts[2]', code: 'UNKNOWN_PROPERTY' },
      { path: 'groupBy', code: 'UNGROUPABLE' },
    ]);
    for (const field of BUILTIN_FIELDS) {
      expect(validateSpec(DEFS, { sorts: [{ field, direction: 'desc' }] })).toEqual([]);
    }
    expect(validateSpec(DEFS, { sorts: [], groupBy: SELECT.id })).toEqual([]);
  });
});

describe('read-time sanitising', () => {
  it('drops the WHOLE filter on one bad leaf, and says so', () => {
    // A leaf forced to true under a `not` would hide every row; a leaf dropped inside an
    // `or` would show fewer rows than intended while looking healthy. All rows plus a
    // warning is the only outcome that is never silent data hiding.
    const filter: Filter = {
      kind: 'or',
      clauses: [leaf(TEXT.id, 'isEmpty'), { kind: 'not', clause: leaf(MISSING, 'isEmpty') }],
    };
    const { spec: out, warnings } = sanitiseSpec(DEFS, spec(filter));
    expect(out.filter).toBeUndefined();
    expect(warnings).toEqual([{ path: 'filter.clauses[1].clause', code: 'UNKNOWN_PROPERTY' }]);
  });

  it('tolerates a select operand naming an option that no longer exists', () => {
    // The option was removed on another device. The filter is still the user's intent;
    // that leaf simply matches nothing.
    const filter: Filter = { kind: 'leaf', property: SELECT.id, op: 'optionIs', value: id(42) };
    const { spec: out, warnings } = sanitiseSpec(DEFS, spec(filter));
    expect(out.filter?.expr).toEqual(filter);
    expect(warnings).toEqual([]);
  });

  it('drops invalid sorts one by one and an invalid group, keeping the rest', () => {
    const { spec: out, warnings } = sanitiseSpec(DEFS, {
      sorts: [
        { field: NUMBER.id, direction: 'asc' },
        { field: MISSING, direction: 'asc' },
        { field: 'createdAt', direction: 'desc' },
      ],
      groupBy: MISSING,
    });
    expect(out.sorts).toEqual([
      { field: NUMBER.id, direction: 'asc' },
      { field: 'createdAt', direction: 'desc' },
    ]);
    expect(out.groupBy).toBeUndefined();
    expect(warnings).toEqual([
      { path: 'sorts[1]', code: 'UNKNOWN_PROPERTY' },
      { path: 'groupBy', code: 'UNKNOWN_PROPERTY' },
    ]);
  });

  it('ignores a filter from a newer grammar with a warning, rather than guessing', () => {
    const newer: ViewSpec = { sorts: [], filter: { v: 99, expr: leaf(TEXT.id, 'isEmpty') } };
    const { spec: out, warnings } = sanitiseSpec(DEFS, newer);
    expect(out.filter).toBeUndefined();
    expect(warnings).toEqual([{ path: 'filter', code: 'UNSUPPORTED_VERSION' }]);
  });

  it('is idempotent', () => {
    const messy: ViewSpec = {
      sorts: [{ field: MISSING, direction: 'asc' }],
      filter: { v: 1, expr: leaf(MISSING, 'isEmpty') },
      groupBy: TEXT.id,
    };
    const once = sanitiseSpec(DEFS, messy).spec;
    const twice = sanitiseSpec(DEFS, once);
    expect(twice.spec).toEqual(once);
    expect(twice.warnings).toEqual([]);
  });
});

describe('relative dates', () => {
  it("resolve to the calendar day in the viewer's zone, so two zones can disagree about today", () => {
    // 23:30 UTC on the 16th: still the 16th in Los Angeles, already the 17th in Tokyo.
    const nowMs = Date.UTC(2026, 8, 16, 23, 30);
    const filter: Filter = {
      kind: 'and',
      clauses: [
        { kind: 'leaf', property: DATE.id, op: 'onDate', value: { kind: 'relative', days: 0 } },
        {
          kind: 'leaf',
          property: DATETIME.id,
          op: 'before',
          value: { kind: 'relative', days: -1 },
        },
        leaf(TEXT.id, 'isEmpty'),
      ],
    };
    const la = resolveDates(filter, { nowMs, timeZone: 'America/Los_Angeles' });
    const tokyo = resolveDates(filter, { nowMs, timeZone: 'Asia/Tokyo' });
    const days = (f: Filter) =>
      filterLeaves(f).flatMap((l) =>
        'value' in l && typeof l.value === 'object' && 'date' in l.value ? [l.value.date] : [],
      );
    expect(days(la)).toEqual(['2026-09-16', '2026-09-15']);
    expect(days(tokyo)).toEqual(['2026-09-17', '2026-09-16']);
    // Absolute dates and non-date leaves are untouched.
    expect(filterLeaves(la)[2]).toEqual(leaf(TEXT.id, 'isEmpty'));
  });
});

describe('stripping a property', () => {
  it('removes its leaves and collapses what becomes empty', () => {
    const filter: Filter = {
      kind: 'and',
      clauses: [
        leaf(TEXT.id, 'isEmpty'),
        { kind: 'or', clauses: [leaf(NUMBER.id, 'eq'), leaf(NUMBER.id, 'gt')] },
        { kind: 'not', clause: leaf(NUMBER.id, 'isEmpty') },
      ],
    };
    expect(stripProperty(filter, NUMBER.id)).toEqual({
      kind: 'and',
      clauses: [leaf(TEXT.id, 'isEmpty')],
    });
    expect(stripProperty(filter, TEXT.id)).toEqual({
      kind: 'and',
      clauses: [
        { kind: 'or', clauses: [leaf(NUMBER.id, 'eq'), leaf(NUMBER.id, 'gt')] },
        { kind: 'not', clause: leaf(NUMBER.id, 'isEmpty') },
      ],
    });
    expect(stripProperty(leaf(TEXT.id, 'isEmpty'), TEXT.id)).toBeUndefined();
    expect(stripProperty(leaf(TEXT.id, 'isEmpty'), NUMBER.id)).toEqual(leaf(TEXT.id, 'isEmpty'));
  });
});

describe('parsing stored JSON', () => {
  it('accepts every well-formed leaf and rejects every malformed shape', () => {
    for (const d of DEFS) {
      for (const op of OPS_BY_TYPE[d.type]) {
        const l = leaf(d.id, op);
        expect(parseFilter(JSON.parse(JSON.stringify(l)))).toEqual(l);
      }
    }
    const junk: unknown[] = [
      null,
      1,
      'and',
      [],
      { kind: 'and' },
      { kind: 'and', clauses: [1] },
      { kind: 'not' },
      { kind: 'leaf', property: TEXT.id },
      { kind: 'leaf', property: TEXT.id, op: 'explode', value: 1 },
      { kind: 'leaf', property: TEXT.id, op: 'equals', value: 1 },
      { kind: 'leaf', property: TEXT.id, op: 'eq', value: '1' },
      { kind: 'leaf', property: TEXT.id, op: 'is', value: 'yes' },
      { kind: 'leaf', property: TEXT.id, op: 'onDate', value: { kind: 'on', date: '2026-02-30' } },
      { kind: 'leaf', property: TEXT.id, op: 'onDate', value: { kind: 'relative', days: 1.5 } },
      { kind: 'leaf', property: 7, op: 'isEmpty' },
    ];
    for (const raw of junk) expect(parseFilter(raw), JSON.stringify(raw)).toBeUndefined();
  });

  it('parses a stored filter with its version, and rejects one without', () => {
    expect(parseStoredFilter({ v: 1, expr: leaf(TEXT.id, 'isEmpty') })).toEqual({
      v: 1,
      expr: leaf(TEXT.id, 'isEmpty'),
    });
    expect(parseStoredFilter({ expr: leaf(TEXT.id, 'isEmpty') })).toBeUndefined();
    expect(parseStoredFilter({ v: 1 })).toBeUndefined();
    expect(parseStoredFilter({ v: 'one', expr: leaf(TEXT.id, 'isEmpty') })).toBeUndefined();
  });
});
