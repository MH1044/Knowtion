/**
 * The JavaScript interpreter of a view: filter, sort and group rows held in memory.
 *
 * One of two. The read model compiles the same spec to SQL for the table view; this one
 * runs over `Page` objects for the simulator, for tests without SQLite, and as the oracle
 * the SQL side is checked against. Every semantic decision is taken in `properties.ts`
 * and `query.ts` and merely applied here, so the two cannot drift by construction — the
 * SQL projection stores the outputs of the same functions this calls.
 *
 * Emptiness and negation are the two places interpreters usually disagree. A positive
 * operator on an empty cell is false; `ne` and `lacksOption` are defined as negations, so
 * empty cells match them; empties sort last in both directions. SQL's three-valued logic
 * never enters, because every SQL leaf is compiled as `exists`/`not exists` over the same
 * rules.
 */

import { compareOrderKeys } from './order-key.js';
import {
  compareCodepoints,
  foldText,
  isEmptyValue,
  localDateOf,
  type CalendarDate,
  type OptionId,
  type PropertyDef,
  type PropertyValue,
} from './properties.js';
import {
  resolveDates,
  sanitiseSpec,
  type Filter,
  type FilterLeaf,
  type QueryContext,
  type QueryProblem,
  type Sort,
  type ViewSpec,
} from './query.js';

/** The part of a page a query needs. `Page` satisfies it structurally. */
export interface QueryRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  properties?: Readonly<Record<string, PropertyValue>>;
  orderKeys?: Readonly<Record<string, string>>;
}

export interface QueryGroup<R extends QueryRow> {
  /** An option id, or null for rows with no value. */
  key: OptionId | null;
  rows: R[];
}

export interface EvaluatedQuery<R extends QueryRow> {
  rows: R[];
  /** Present when the spec groups. Every option gets a bucket, empty or not; null is last. */
  groups?: QueryGroup<R>[];
  warnings: QueryProblem[];
}

type Defs = ReadonlyMap<string, PropertyDef>;

function valueOf(row: QueryRow, property: string): PropertyValue | undefined {
  return row.properties?.[property];
}

function calendarDateOf(value: PropertyValue): CalendarDate | undefined {
  if (value.type === 'date') return value.value;
  if (value.type === 'datetime') return localDateOf(value.value.ms, value.value.zone);
  return undefined;
}

/** One leaf against one row. The filter must already have had its dates resolved. */
function matchesLeaf(row: QueryRow, leaf: FilterLeaf, defs: Defs): boolean {
  const def = defs.get(leaf.property);
  if (def === undefined) return false;
  const value = valueOf(row, leaf.property);
  const empty = isEmptyValue(def, value);

  switch (leaf.op) {
    case 'isEmpty':
      return empty;
    case 'equals':
    case 'contains':
    case 'startsWith': {
      if (empty || value === undefined || (value.type !== 'text' && value.type !== 'url'))
        return false;
      const have = foldText(value.value);
      const want = foldText(leaf.value);
      if (leaf.op === 'equals') return have === want;
      return leaf.op === 'contains' ? have.includes(want) : have.startsWith(want);
    }
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (empty || value?.type !== 'number') return false;
      const n = value.value;
      switch (leaf.op) {
        case 'eq':
          return n === leaf.value;
        case 'lt':
          return n < leaf.value;
        case 'lte':
          return n <= leaf.value;
        case 'gt':
          return n > leaf.value;
        default:
          return n >= leaf.value;
      }
    }
    case 'ne':
      // Defined as not(eq): an empty cell is "not equal to 3".
      return !(!empty && value?.type === 'number' && value.value === leaf.value);
    case 'is': {
      const checked = value?.type === 'checkbox' && value.value;
      return checked === leaf.value;
    }
    case 'optionIs':
      return !empty && value?.type === 'select' && value.value === leaf.value;
    case 'optionIsNot':
      return !(!empty && value?.type === 'select' && value.value === leaf.value);
    case 'hasOption':
      return !empty && value?.type === 'multi-select' && value.value.includes(leaf.value);
    case 'lacksOption':
      return !(!empty && value?.type === 'multi-select' && value.value.includes(leaf.value));
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      if (empty || value === undefined) return false;
      const day = calendarDateOf(value);
      if (day === undefined || leaf.value.kind !== 'on') return false;
      const cmp = compareCodepoints(day, leaf.value.date);
      switch (leaf.op) {
        case 'onDate':
          return cmp === 0;
        case 'before':
          return cmp < 0;
        case 'after':
          return cmp > 0;
        case 'onOrBefore':
          return cmp <= 0;
        default:
          return cmp >= 0;
      }
    }
  }
}

/** A row against a filter whose relative dates have been resolved. */
export function matchesFilter(row: QueryRow, filter: Filter, defs: Defs): boolean {
  switch (filter.kind) {
    case 'and':
      return filter.clauses.every((c) => matchesFilter(row, c, defs));
    case 'or':
      return filter.clauses.some((c) => matchesFilter(row, c, defs));
    case 'not':
      return !matchesFilter(row, filter.clause, defs);
    case 'leaf':
      return matchesLeaf(row, filter, defs);
  }
}

/**
 * Compare two rows on one sort, ignoring direction, or undefined when one side is empty
 * and the caller must place it last.
 */
function compareOnSort(
  a: QueryRow,
  b: QueryRow,
  sort: Sort,
  defs: Defs,
): number | 'a-empty' | 'b-empty' | 'both-empty' {
  switch (sort.field) {
    case 'title': {
      const folded = compareCodepoints(foldText(a.title), foldText(b.title));
      return folded !== 0 ? folded : compareCodepoints(a.title, b.title);
    }
    case 'createdAt':
      return Math.sign(a.createdAt - b.createdAt);
    case 'updatedAt':
      return Math.sign(a.updatedAt - b.updatedAt);
    default: {
      const def = defs.get(sort.field);
      if (def === undefined) return 0;
      const va = valueOf(a, sort.field);
      const vb = valueOf(b, sort.field);
      const ea = isEmptyValue(def, va) || sortKeyOf(def, va) === undefined;
      const eb = isEmptyValue(def, vb) || sortKeyOf(def, vb) === undefined;
      if (ea && eb) return 'both-empty';
      if (ea) return 'a-empty';
      if (eb) return 'b-empty';
      const ka = sortKeyOf(def, va);
      const kb = sortKeyOf(def, vb);
      if (ka === undefined || kb === undefined) return 0;
      if (typeof ka === 'number' && typeof kb === 'number') return Math.sign(ka - kb);
      if (Array.isArray(ka) && Array.isArray(kb)) {
        const folded = compareCodepoints(ka[0], kb[0]);
        return folded !== 0 ? folded : compareCodepoints(ka[1], kb[1]);
      }
      return compareCodepoints(String(ka), String(kb));
    }
  }
}

/**
 * What a value sorts by, per type: a number, a string compared by code point, or a
 * [folded, raw] pair for text. Undefined means "sorts as empty".
 */
function sortKeyOf(
  def: PropertyDef,
  value: PropertyValue | undefined,
): number | string | [string, string] | undefined {
  if (value?.type !== def.type) return def.type === 'checkbox' ? 0 : undefined;
  switch (value.type) {
    case 'text':
    case 'url':
      return [foldText(value.value), value.value];
    case 'number':
      return value.value;
    case 'checkbox':
      return value.value ? 1 : 0;
    case 'select': {
      const position = def.options.findIndex((o) => o.id === value.value);
      return position < 0 ? undefined : position;
    }
    case 'multi-select':
      return undefined; // unsortable; validation never lets one through
    case 'date':
      return value.value;
    case 'datetime':
      return value.value.ms;
  }
}

/**
 * The comparator for a view: the user's sorts, empties last in either direction, then
 * the manual order for `viewId` (keyed rows first, by key), then creation time, then id.
 * The read model mirrors this exactly in its ORDER BY.
 */
export function compareRows(defs: Defs, sorts: readonly Sort[], viewId?: string) {
  return (a: QueryRow, b: QueryRow): number => {
    for (const sort of sorts) {
      const outcome = compareOnSort(a, b, sort, defs);
      if (outcome === 'both-empty') continue;
      if (outcome === 'a-empty') return 1;
      if (outcome === 'b-empty') return -1;
      if (outcome !== 0) return sort.direction === 'desc' ? -outcome : outcome;
    }
    if (viewId !== undefined) {
      const ka = a.orderKeys?.[viewId];
      const kb = b.orderKeys?.[viewId];
      if (ka !== undefined && kb === undefined) return -1;
      if (ka === undefined && kb !== undefined) return 1;
      if (ka !== undefined && kb !== undefined) {
        const byKey = compareOrderKeys(ka, kb);
        if (byKey !== 0) return byKey;
      }
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return compareCodepoints(a.id, b.id);
  };
}

/** The bucket a row belongs to when grouping on a select property. */
export function groupKeyOf(def: PropertyDef, value: PropertyValue | undefined): OptionId | null {
  if (value?.type !== 'select' || isEmptyValue(def, value)) return null;
  return def.options.some((o) => o.id === value.value) ? value.value : null;
}

/**
 * Bucket order for a board: the property's options in schema order (every one, so an
 * empty column still shows), then any other key by code point, then the no-value bucket.
 */
export function orderGroupKeys(
  def: PropertyDef,
  keys: Iterable<OptionId | null>,
): (OptionId | null)[] {
  const defined = def.options.map((o) => o.id);
  const seen = new Set<OptionId | null>(keys);
  const extra = [...seen]
    .filter((k): k is OptionId => k !== null && !defined.includes(k))
    .sort(compareCodepoints);
  return [...defined, ...extra, null];
}

/**
 * Run a view over rows in memory. The spec is sanitised and its dates resolved here, so
 * the caller hands over exactly what the CRDT holds and gets back what the user sees.
 */
export function evaluateQuery<R extends QueryRow>(
  rows: readonly R[],
  defs: readonly PropertyDef[],
  spec: ViewSpec,
  ctx: QueryContext,
  viewId?: string,
): EvaluatedQuery<R> {
  const index: Defs = new Map(defs.map((d) => [d.id, d]));
  const { spec: clean, warnings } = sanitiseSpec(defs, spec);
  const filter = clean.filter === undefined ? undefined : resolveDates(clean.filter.expr, ctx);

  const matched =
    filter === undefined ? [...rows] : rows.filter((row) => matchesFilter(row, filter, index));
  matched.sort(compareRows(index, clean.sorts, viewId));

  const result: EvaluatedQuery<R> = { rows: matched, warnings };
  if (clean.groupBy !== undefined) {
    const def = index.get(clean.groupBy);
    if (def !== undefined) {
      const keyed = matched.map((row) => ({ row, key: groupKeyOf(def, valueOf(row, def.id)) }));
      result.groups = orderGroupKeys(
        def,
        keyed.map((k) => k.key),
      ).map((key) => ({ key, rows: keyed.filter((k) => k.key === key).map((k) => k.row) }));
    }
  }
  return result;
}
