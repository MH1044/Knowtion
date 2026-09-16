/**
 * The JavaScript interpreter, run over the shared semantic table.
 *
 * Every case in query-cases.ts is asserted here and, in the read model's suite, through
 * the SQL compiler. A rule that held in one interpreter only would show up as a case one
 * of the two suites cannot pass.
 */
import { describe, expect, it } from 'vitest';

import { compareRows, evaluateQuery, groupKeyOf, orderGroupKeys } from '../evaluate.js';
import { bytesToUuid } from '../ids.js';
import type { OptionId } from '../properties.js';
import {
  CASE_DEFS,
  CASE_OPTIONS,
  CASE_PROPERTIES,
  CASE_ROWS,
  CASE_VIEW,
  QUERY_CASES,
} from '../query-cases.js';

const DEFAULT_CTX = { nowMs: Date.UTC(2026, 0, 10, 23, 30), timeZone: 'UTC' };

/** Unwraps a lookup the test knows must have succeeded. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

describe('the semantic table', () => {
  it.each(QUERY_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = evaluateQuery(
      CASE_ROWS,
      CASE_DEFS,
      c.spec,
      c.ctx ?? DEFAULT_CTX,
      c.inView === true ? CASE_VIEW : undefined,
    );
    expect(result.rows.map((r) => r.id)).toEqual(c.expected);
    expect(result.warnings.map((w) => w.code)).toEqual(c.expectedWarnings ?? []);
    if (c.expectedGroups !== undefined) {
      expect(result.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual(c.expectedGroups);
    } else {
      expect(result.groups).toBeUndefined();
    }
  });

  it('covers every operator of every type at least once', () => {
    // A case table that quietly skipped an operator would let the interpreters disagree
    // on it unnoticed.
    const seen = new Set<string>();
    const walk = (f: unknown): void => {
      if (typeof f !== 'object' || f === null) return;
      const node = f as { kind: string; op?: string; clauses?: unknown[]; clause?: unknown };
      if (node.kind === 'leaf' && node.op !== undefined) seen.add(node.op);
      node.clauses?.forEach(walk);
      walk(node.clause);
    };
    for (const c of QUERY_CASES) walk(c.spec.filter?.expr);
    expect([...seen].sort()).toEqual(
      [
        'isEmpty',
        'equals',
        'contains',
        'startsWith',
        'eq',
        'ne',
        'lt',
        'lte',
        'gt',
        'gte',
        'is',
        'optionIs',
        'optionIsNot',
        'hasOption',
        'lacksOption',
        'onDate',
        'before',
        'after',
        'onOrBefore',
        'onOrAfter',
      ].sort(),
    );
  });
});

describe('pieces', () => {
  const selectDef = must(
    CASE_DEFS.find((d) => d.id === CASE_PROPERTIES.SELECT),
    'the select property',
  );

  it('the comparator is a total order with the documented tie-break', () => {
    const cmp = compareRows(new Map(CASE_DEFS.map((d) => [d.id, d])), [], CASE_VIEW);
    const sorted = [...CASE_ROWS].sort(cmp).map((r) => r.id);
    expect(sorted).toEqual(['r6', 'r1', 'r3', 'r2', 'r4', 'r5']);
    // Antisymmetric and reflexive on a sample.
    const [a, b] = [CASE_ROWS[0], CASE_ROWS[1]];
    if (a === undefined || b === undefined) throw new Error('fixture rows');
    expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)));
    expect(cmp(a, a)).toBe(0);
  });

  it('bucket order is schema options, then strangers by code point, then no value', () => {
    const stranger: OptionId = bytesToUuid(new Uint8Array(16).fill(0xee));
    expect(orderGroupKeys(selectDef, [null, stranger, CASE_OPTIONS.BLUE])).toEqual([
      CASE_OPTIONS.RED,
      CASE_OPTIONS.BLUE,
      CASE_OPTIONS.GREEN,
      stranger,
      null,
    ]);
  });

  it('a group key is the option id, or null for anything else', () => {
    expect(groupKeyOf(selectDef, { type: 'select', value: CASE_OPTIONS.RED })).toBe(
      CASE_OPTIONS.RED,
    );
    expect(
      groupKeyOf(selectDef, { type: 'select', value: bytesToUuid(new Uint8Array(16).fill(7)) }),
    ).toBeNull();
    expect(groupKeyOf(selectDef, { type: 'text', value: 'x' })).toBeNull();
    expect(groupKeyOf(selectDef, undefined)).toBeNull();
  });

  it('does not mutate the rows it is given', () => {
    const before = JSON.stringify(CASE_ROWS);
    evaluateQuery(
      CASE_ROWS,
      CASE_DEFS,
      { sorts: [{ field: 'title', direction: 'desc' }] },
      DEFAULT_CTX,
    );
    expect(JSON.stringify(CASE_ROWS)).toBe(before);
  });
});
