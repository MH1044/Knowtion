/**
 * The twin interpreters agree on random schemas, rows and specs.
 *
 * The case table pins the rules a person can enumerate. This generates what a person
 * would not: unicode text with case and normalisation differences, negative zero, ties on
 * every key, values of the wrong kind, dates straddling year ends, datetimes in several
 * zones, filters that nest, specs with dangling references, and every combination of
 * sort and group. For each, the rows the SQL side returns must be the rows the JavaScript
 * side returns, in the same order, in the same buckets, with the same warnings.
 *
 * Rows are built as plain Pages rather than through the CRDT: what is under test is the
 * pair of interpreters, not the engine's storage, and the decoupling keeps the
 * generator fast enough to run hundreds of times.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  OPS_BY_TYPE,
  evaluateQuery,
  toWellFormedText,
  type CalendarDate,
  type Filter,
  type FilterLeaf,
  type NodeId,
  type Page,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type PropertyValue,
  type Sort,
  type Uuid,
  type ViewSpec,
} from '@knowtion/engine';

import { ReadModel } from '../read-model.js';

const DATABASE_ID = '1@1' as NodeId;
const VIEW_ID = 'ffffffff-0000-7000-8000-000000000001' as Uuid;
const CTX = { nowMs: Date.UTC(2026, 0, 10, 23, 30), timeZone: 'Asia/Tokyo' };

const uuidOf = (n: number): Uuid =>
  `${n.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000` as Uuid;

const TYPES: PropertyType[] = [
  'text',
  'number',
  'checkbox',
  'select',
  'multi-select',
  'date',
  'datetime',
  'url',
];

const arbText = fc.oneof(
  fc.constant(''),
  fc.constantFrom('Hello', 'hello', 'HELLO', 'Café', 'Café', 'z', 'é', 'Ｚ', '😀', ' a'),
  fc.string({ unit: 'binary', maxLength: 6 }),
);
const arbDate = fc
  .record({
    y: fc.integer({ min: 2025, max: 2027 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ y, m, d }) =>
      `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as CalendarDate,
  );
const arbZone = fc.constantFrom(
  'UTC',
  'Asia/Tokyo',
  'America/Los_Angeles',
  'Pacific/Kiritimati',
  'Mars/Nowhere',
);

/** A schema of one to six properties. Select types get one to four options. */
const arbSchema: fc.Arbitrary<PropertyDef[]> = fc
  .array(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 6 })
  .chain((types) =>
    fc.tuple(
      ...types.map((type, i) =>
        fc.integer({ min: 1, max: 4 }).map((optionCount): PropertyDef => ({
          id: uuidOf(100 + i),
          name: `p${String(i)}`,
          type,
          createdAt: 0,
          options:
            type === 'select' || type === 'multi-select'
              ? Array.from({ length: optionCount }, (_, k) => ({
                  id: uuidOf(1000 + i * 10 + k),
                  name: `o${String(k)}`,
                }))
              : [],
        })),
      ),
    ),
  );

function arbValue(def: PropertyDef): fc.Arbitrary<PropertyValue> {
  const options = def.options.map((o) => o.id);
  switch (def.type) {
    case 'text':
      return arbText.map((value) => ({ type: 'text', value }));
    case 'url':
      return arbText.map((value) => ({ type: 'url', value }));
    case 'number':
      return fc
        .oneof(fc.integer({ min: -5, max: 5 }), fc.constantFrom(-0, 0, 0.5, 1e300, -1e-9))
        .map((value) => ({ type: 'number', value }));
    case 'checkbox':
      return fc.boolean().map((value) => ({ type: 'checkbox', value }));
    case 'select':
      return fc.constantFrom(...options, uuidOf(9999)).map((value) => ({ type: 'select', value }));
    case 'multi-select':
      return fc
        .subarray([...options, uuidOf(9999)])
        .map((value) => ({ type: 'multi-select', value }));
    case 'date':
      return arbDate.map((value) => ({ type: 'date', value }));
    case 'datetime':
      return fc
        .record({
          ms: fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 0, 1) }),
          zone: arbZone,
        })
        .map((value) => ({ type: 'datetime', value }));
  }
}

/** A row's values: each property present with probability 0.7; 1 in 10 of the wrong kind. */
function arbRow(defs: PropertyDef[], index: number): fc.Arbitrary<Page> {
  const values = fc.tuple(
    ...defs.map((def) =>
      fc.oneof(
        { weight: 3, arbitrary: fc.constant(undefined) },
        { weight: 6, arbitrary: arbValue(def) },
        {
          weight: 1,
          arbitrary: arbValue({
            ...def,
            type: def.type === 'text' ? 'number' : 'text',
            options: [],
          }),
        },
      ),
    ),
  );
  return fc
    .tuple(
      values,
      fc.option(fc.constantFrom('a0', 'a1', 'a2', 'a0V', 'Zz'), { nil: undefined }),
      fc.integer({ min: 1, max: 4 }),
    )
    .map(([values, orderKey, createdAt]): Page => {
      const properties: Record<PropertyId, PropertyValue> = {};
      defs.forEach((def, i) => {
        const value = values[i];
        if (value !== undefined) properties[def.id] = value;
      });
      return {
        id: `${String(index + 2)}@1` as NodeId,
        parentId: DATABASE_ID,
        uuid: uuidOf(index + 2),
        title: index % 3 === 0 ? 'Row' : `row ${String(index)}`,
        createdAt,
        updatedAt: createdAt,
        properties,
        ...(orderKey === undefined
          ? {}
          : { orderKeys: { [VIEW_ID]: orderKey } as Page['orderKeys'] & object }),
      };
    });
}

function arbLeaf(defs: PropertyDef[]): fc.Arbitrary<FilterLeaf> {
  const dangling: PropertyDef = {
    id: uuidOf(777),
    name: 'gone',
    type: 'text',
    createdAt: 0,
    options: [],
  };
  return fc
    .oneof(
      { weight: 9, arbitrary: fc.constantFrom(...defs) },
      { weight: 1, arbitrary: fc.constant(dangling) },
    )
    .chain((def) => {
      const property = def.id;
      const ops = OPS_BY_TYPE[def.type];
      return fc.constantFrom(...ops).chain((op): fc.Arbitrary<FilterLeaf> => {
        switch (op) {
          case 'isEmpty':
            return fc.constant({ kind: 'leaf', property, op });
          case 'equals':
          case 'contains':
          case 'startsWith':
            return arbText.map((value) => ({ kind: 'leaf', property, op, value }));
          case 'eq':
          case 'ne':
          case 'lt':
          case 'lte':
          case 'gt':
          case 'gte':
            return fc
              .constantFrom(-1, 0, 0.5, 1, 1e300)
              .map((value) => ({ kind: 'leaf', property, op, value }));
          case 'is':
            return fc.boolean().map((value) => ({ kind: 'leaf', property, op, value }));
          case 'optionIs':
          case 'optionIsNot':
          case 'hasOption':
          case 'lacksOption':
            return fc
              .constantFrom(...def.options.map((o) => o.id), uuidOf(9999))
              .map((value) => ({ kind: 'leaf', property, op, value }));
          case 'onDate':
          case 'before':
          case 'after':
          case 'onOrBefore':
          case 'onOrAfter':
            return fc
              .oneof(
                arbDate.map((date) => ({ kind: 'on' as const, date })),
                fc
                  .integer({ min: -2, max: 2 })
                  .map((days) => ({ kind: 'relative' as const, days })),
              )
              .map((value) => ({ kind: 'leaf', property, op, value }));
        }
      });
    });
}

function arbFilter(defs: PropertyDef[], depth: number): fc.Arbitrary<Filter> {
  if (depth === 0) return arbLeaf(defs);
  return fc.oneof(
    { weight: 3, arbitrary: arbLeaf(defs) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom('and' as const, 'or' as const),
          fc.array(arbFilter(defs, depth - 1), { maxLength: 3 }),
        )
        .map(([kind, clauses]) => ({ kind, clauses })),
    },
    {
      weight: 1,
      arbitrary: arbFilter(defs, depth - 1).map((clause) => ({ kind: 'not' as const, clause })),
    },
  );
}

function arbSpec(defs: PropertyDef[]): fc.Arbitrary<ViewSpec> {
  const sortable = defs.filter((d) => d.type !== 'multi-select');
  const sortFields: Sort['field'][] = [
    ...sortable.map((d) => d.id),
    'title',
    'createdAt',
    uuidOf(777),
  ];
  const selects = defs.filter((d) => d.type === 'select');
  return fc
    .record({
      filter: fc.option(arbFilter(defs, 2), { nil: undefined }),
      sorts: fc.array(
        fc.record({
          field: fc.constantFrom(...sortFields),
          direction: fc.constantFrom('asc' as const, 'desc' as const),
        }),
        { maxLength: 3 },
      ),
      groupBy: fc.option(fc.constantFrom(...selects.map((d) => d.id), defs[0]?.id ?? uuidOf(777)), {
        nil: undefined,
      }),
    })
    .map(({ filter, sorts, groupBy }) => ({
      sorts,
      ...(filter === undefined ? {} : { filter: { v: 1, expr: filter } }),
      ...(groupBy === undefined ? {} : { groupBy }),
    }));
}

const arbCase = arbSchema.chain((defs) =>
  fc.record({
    defs: fc.constant(defs),
    rows: fc
      .integer({ min: 0, max: 30 })
      .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => arbRow(defs, i)))),
    spec: arbSpec(defs),
    inView: fc.boolean(),
  }),
);

function databasePage(defs: PropertyDef[]): Page {
  return {
    id: DATABASE_ID,
    parentId: undefined,
    uuid: uuidOf(1),
    title: 'db',
    createdAt: 0,
    updatedAt: 0,
    database: {
      createdAt: 0,
      properties: defs,
      views: [
        {
          id: VIEW_ID,
          name: 'v',
          type: 'table',
          sorts: [],
          columns: defs.map((d) => d.id),
          hidden: [],
          createdAt: 0,
        },
      ],
    },
  };
}

describe('twin interpreters', () => {
  it('return the same rows, in the same order, in the same buckets, with the same warnings', () => {
    fc.assert(
      fc.property(arbCase, ({ defs, rows, spec, inView }) => {
        // Text the two sides cannot both carry is out of scope: the engine well-forms text
        // at write time, so lone surrogates never reach either interpreter in practice.
        const wellFormed = rows.every((row) =>
          Object.values(row.properties ?? {}).every(
            (v) => typeof v.value !== 'string' || toWellFormedText(v.value) === v.value,
          ),
        );
        fc.pre(wellFormed);

        const viewId = inView ? VIEW_ID : undefined;
        const expected = evaluateQuery(rows, defs, spec, CTX, viewId);

        const model = ReadModel.open(':memory:');
        try {
          model.projectPages([databasePage(defs), ...rows]);
          const actual = model.query(DATABASE_ID, spec, CTX, {}, viewId);
          expect(actual.rows.map((r) => r.id)).toEqual(expected.rows.map((r) => r.id));
          expect(actual.total).toBe(expected.rows.length);
          expect(actual.warnings).toEqual(expected.warnings);
          expect(actual.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual(
            expected.groups?.map((g) => [g.key, g.rows.map((r) => r.id)]),
          );
        } finally {
          model.close();
        }
      }),
      { numRuns: 250, verbose: true },
    );
  });
});
