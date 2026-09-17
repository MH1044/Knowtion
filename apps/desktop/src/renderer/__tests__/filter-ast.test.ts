import { describe, expect, it } from 'vitest';

import type { Filter, FilterLeaf, PropertyDef, PropertyType } from '../api.js';
import {
  OPS_BY_TYPE,
  OP_LABELS,
  build,
  defaultLeaf,
  flatten,
  isComplete,
  opsFor,
  withOp,
} from '../database/filter-ast.js';

function def(type: PropertyType, options: string[] = []): PropertyDef {
  return {
    id: `p-${type}`,
    name: type,
    type,
    createdAt: 0,
    options: options.map((id) => ({ id, name: id })),
  };
}

const ALL_TYPES: PropertyType[] = [
  'text',
  'number',
  'checkbox',
  'select',
  'multi-select',
  'date',
  'datetime',
  'url',
];

describe('the operator table', () => {
  it('covers every property type and labels every operator', () => {
    for (const type of ALL_TYPES) {
      expect(opsFor(type).length).toBeGreaterThan(0);
      for (const op of opsFor(type)) expect(OP_LABELS[op]).toBeTypeOf('string');
    }
    expect(Object.keys(OPS_BY_TYPE).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('starts every type at a complete-or-empty first clause', () => {
    for (const type of ALL_TYPES) {
      const leaf = defaultLeaf(def(type, ['a']));
      expect(leaf.property).toBe(`p-${type}`);
      expect(opsFor(type)).toContain(leaf.op);
    }
    // Checkbox has no "is empty"; it starts as "is checked".
    expect(defaultLeaf(def('checkbox'))).toEqual({
      kind: 'leaf',
      property: 'p-checkbox',
      op: 'is',
      value: true,
    });
  });
});

describe('changing an operator', () => {
  const text = def('text');
  const number = def('number');
  const select = def('select', ['todo', 'done']);
  const date = def('date');

  it('keeps an operand of the same kind and resets one of another kind', () => {
    const contains: FilterLeaf = { kind: 'leaf', property: text.id, op: 'contains', value: 'abc' };
    expect(withOp(contains, text, 'startsWith')).toEqual({ ...contains, op: 'startsWith' });
    expect(withOp(contains, text, 'isEmpty')).toEqual({
      kind: 'leaf',
      property: text.id,
      op: 'isEmpty',
    });
    const lt: FilterLeaf = { kind: 'leaf', property: number.id, op: 'lt', value: 4 };
    expect(withOp(lt, number, 'gte')).toEqual({ ...lt, op: 'gte' });
    expect(withOp({ kind: 'leaf', property: number.id, op: 'isEmpty' }, number, 'eq')).toEqual({
      kind: 'leaf',
      property: number.id,
      op: 'eq',
      value: 0,
    });
  });

  it('seeds a select operand with the first option and keeps a known one', () => {
    expect(
      withOp({ kind: 'leaf', property: select.id, op: 'isEmpty' }, select, 'optionIs'),
    ).toEqual({ kind: 'leaf', property: select.id, op: 'optionIs', value: 'todo' });
    const done: FilterLeaf = { kind: 'leaf', property: select.id, op: 'optionIs', value: 'done' };
    expect(withOp(done, select, 'optionIsNot')).toEqual({ ...done, op: 'optionIsNot' });
    const stale: FilterLeaf = { kind: 'leaf', property: select.id, op: 'optionIs', value: 'gone' };
    expect(withOp(stale, select, 'optionIsNot')).toEqual({
      ...stale,
      op: 'optionIsNot',
      value: 'todo',
    });
  });

  it('seeds a date operand with "today" and keeps an absolute day', () => {
    expect(withOp({ kind: 'leaf', property: date.id, op: 'isEmpty' }, date, 'before')).toEqual({
      kind: 'leaf',
      property: date.id,
      op: 'before',
      value: { kind: 'relative', days: 0 },
    });
    const on: FilterLeaf = {
      kind: 'leaf',
      property: date.id,
      op: 'onDate',
      value: { kind: 'on', date: '2026-02-28' },
    };
    expect(withOp(on, date, 'after')).toEqual({ ...on, op: 'after' });
  });
});

describe('completeness', () => {
  it('drops clauses that have no operand yet, and keeps the rest', () => {
    const p = 'p';
    expect(isComplete({ kind: 'leaf', property: p, op: 'isEmpty' })).toBe(true);
    expect(isComplete({ kind: 'leaf', property: p, op: 'contains', value: '' })).toBe(false);
    expect(isComplete({ kind: 'leaf', property: p, op: 'contains', value: 'x' })).toBe(true);
    expect(isComplete({ kind: 'leaf', property: p, op: 'eq', value: Number.NaN })).toBe(false);
    expect(isComplete({ kind: 'leaf', property: p, op: 'optionIs', value: '' })).toBe(false);
    expect(
      isComplete({ kind: 'leaf', property: p, op: 'onDate', value: { kind: 'on', date: '' } }),
    ).toBe(false);
    expect(
      isComplete({
        kind: 'leaf',
        property: p,
        op: 'onDate',
        value: { kind: 'relative', days: -1 },
      }),
    ).toBe(true);
  });
});

describe('flattening and building', () => {
  const a: FilterLeaf = { kind: 'leaf', property: 'a', op: 'isEmpty' };
  const b: FilterLeaf = { kind: 'leaf', property: 'b', op: 'contains', value: 'x' };

  it('shows nothing, one leaf, and a flat group', () => {
    expect(flatten(undefined)).toEqual({ join: 'and', leaves: [] });
    expect(flatten(a)).toEqual({ join: 'and', leaves: [a] });
    expect(flatten({ kind: 'or', clauses: [a, b] })).toEqual({ join: 'or', leaves: [a, b] });
  });

  it('refuses a nested filter rather than rewriting it', () => {
    const nested: Filter = { kind: 'and', clauses: [a, { kind: 'or', clauses: [b] }] };
    expect(flatten(nested)).toBeNull();
    expect(flatten({ kind: 'not', clause: a })).toBeNull();
  });

  it('builds the smallest filter that means the same thing', () => {
    expect(build({ join: 'and', leaves: [] })).toBeUndefined();
    expect(build({ join: 'or', leaves: [a] })).toEqual(a);
    expect(build({ join: 'or', leaves: [a, b] })).toEqual({ kind: 'or', clauses: [a, b] });
    // Incomplete clauses are left out, and a group of one collapses.
    const blank: FilterLeaf = { kind: 'leaf', property: 'c', op: 'contains', value: '' };
    expect(build({ join: 'and', leaves: [blank, b] })).toEqual(b);
  });

  it('round-trips a flat filter through the engine shape', () => {
    const flat = { join: 'and' as const, leaves: [a, b] };
    const built = build(flat);
    expect(built).toBeDefined();
    expect(flatten(built)).toEqual(flat);
  });
});
