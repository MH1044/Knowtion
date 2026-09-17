/**
 * The filter editor's view of a filter.
 *
 * The engine's filter is a tree: and/or/not over leaves, eight deep and sixty-four wide
 * at most. The editor edits the shape people actually build — a flat list of leaves
 * joined by one "all" or "any" — and refuses to edit anything deeper rather than
 * quietly rewriting it. A filter it cannot show is reported as such, so the component
 * can offer to replace it and nothing else.
 *
 * The operator table mirrors the engine's `OPS_BY_TYPE`; the renderer cannot import the
 * engine, and the main process validates strictly on write, so drift here costs an
 * error message rather than a wrong row. The equivalence test in this folder checks the
 * two tables against the shared types by exhaustion of the leaf union.
 */
import type { DateOperand, Filter, FilterLeaf, PropertyDef, PropertyType } from '../api.js';

export type FilterOp = FilterLeaf['op'];
export type Join = 'and' | 'or';

export const OPS_BY_TYPE: Record<PropertyType, readonly FilterOp[]> = {
  text: ['isEmpty', 'equals', 'contains', 'startsWith'],
  url: ['isEmpty', 'equals', 'contains', 'startsWith'],
  number: ['isEmpty', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  checkbox: ['is'],
  select: ['isEmpty', 'optionIs', 'optionIsNot'],
  'multi-select': ['isEmpty', 'hasOption', 'lacksOption'],
  date: ['isEmpty', 'onDate', 'before', 'after', 'onOrBefore', 'onOrAfter'],
  datetime: ['isEmpty', 'onDate', 'before', 'after', 'onOrBefore', 'onOrAfter'],
};

export const OP_LABELS: Record<FilterOp, string> = {
  isEmpty: 'is empty',
  equals: 'is',
  contains: 'contains',
  startsWith: 'starts with',
  eq: '=',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  is: 'is',
  optionIs: 'is',
  optionIsNot: 'is not',
  hasOption: 'has',
  lacksOption: 'lacks',
  onDate: 'is',
  before: 'is before',
  after: 'is after',
  onOrBefore: 'is on or before',
  onOrAfter: 'is on or after',
};

/** Relative-day presets offered beside a date operand. Resolved in the viewer's zone. */
export const RELATIVE_PRESETS: readonly { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: 'Yesterday', days: -1 },
  { label: 'Tomorrow', days: 1 },
  { label: 'A week ago', days: -7 },
  { label: 'In a week', days: 7 },
  { label: 'A month ago', days: -30 },
  { label: 'In a month', days: 30 },
];

export function opsFor(type: PropertyType): readonly FilterOp[] {
  return OPS_BY_TYPE[type];
}

/** The leaf a new clause starts as: the property's first operator with an empty operand. */
export function defaultLeaf(def: PropertyDef): FilterLeaf {
  return withOp(
    { kind: 'leaf', property: def.id, op: 'isEmpty' },
    def,
    opsFor(def.type)[0] ?? 'isEmpty',
  );
}

/**
 * Change a leaf's operator, keeping the operand when the new operator takes the same
 * kind and resetting it otherwise. A select's first option seeds an option operand so the
 * clause is never "is <nothing>".
 */
export function withOp(leaf: FilterLeaf, def: PropertyDef, op: FilterOp): FilterLeaf {
  const property = leaf.property;
  // The `isEmpty` leaf has no operand, so the union has no `.value`; read it as unknown.
  const current: unknown = 'value' in leaf ? leaf.value : undefined;
  switch (op) {
    case 'isEmpty':
      return { kind: 'leaf', property, op };
    case 'equals':
    case 'contains':
    case 'startsWith':
      return { kind: 'leaf', property, op, value: typeof current === 'string' ? current : '' };
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { kind: 'leaf', property, op, value: typeof current === 'number' ? current : 0 };
    case 'is':
      return { kind: 'leaf', property, op, value: typeof current === 'boolean' ? current : true };
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption': {
      const known = typeof current === 'string' && def.options.some((o) => o.id === current);
      const value = known ? current : (def.options[0]?.id ?? '');
      return { kind: 'leaf', property, op, value };
    }
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter':
      return {
        kind: 'leaf',
        property,
        op,
        value: isDateOperand(current) ? current : { kind: 'relative', days: 0 },
      };
  }
}

function isDateOperand(value: unknown): value is DateOperand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; date?: unknown; days?: unknown };
  return (
    (v.kind === 'on' && typeof v.date === 'string') ||
    (v.kind === 'relative' && typeof v.days === 'number')
  );
}

/** Whether a leaf is complete enough to send: no empty text, no missing option or date. */
export function isComplete(leaf: FilterLeaf): boolean {
  switch (leaf.op) {
    case 'isEmpty':
    case 'is':
      return true;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return Number.isFinite(leaf.value);
    case 'equals':
    case 'contains':
    case 'startsWith':
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption':
      return leaf.value !== '';
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter':
      return leaf.value.kind === 'relative' || leaf.value.date !== '';
  }
}

export interface FlatFilter {
  join: Join;
  leaves: FilterLeaf[];
}

/**
 * A filter as the editor can show it, or null when it is nested (a `not`, or a group
 * inside a group). A lone leaf is a one-clause "all".
 */
export function flatten(filter: Filter | undefined): FlatFilter | null {
  if (filter === undefined) return { join: 'and', leaves: [] };
  if (filter.kind === 'leaf') return { join: 'and', leaves: [filter] };
  if (filter.kind === 'not') return null;
  const leaves: FilterLeaf[] = [];
  for (const clause of filter.clauses) {
    if (clause.kind !== 'leaf') return null;
    leaves.push(clause);
  }
  return { join: filter.kind, leaves };
}

/** The filter to store: undefined when there are no clauses, a bare leaf when there is one. */
export function build(flat: FlatFilter): Filter | undefined {
  const leaves = flat.leaves.filter(isComplete);
  if (leaves.length === 0) return undefined;
  if (leaves.length === 1) return leaves[0];
  return { kind: flat.join, clauses: leaves };
}

/** Which properties a sort can use. Multi-select has no single value to order by. */
export const SORTABLE_TYPES: readonly PropertyType[] = [
  'text',
  'url',
  'number',
  'checkbox',
  'select',
  'date',
  'datetime',
];

export const GROUPABLE_TYPES: readonly PropertyType[] = ['select'];

/** The sort fields that are not properties. */
export const BUILTIN_SORT_FIELDS: readonly { id: string; name: string }[] = [
  { id: 'title', name: 'Title' },
  { id: 'createdAt', name: 'Created' },
  { id: 'updatedAt', name: 'Updated' },
];
