/**
 * The filter, sort and group language a view is expressed in.
 *
 * Plain JSON, stored on the view in the CRDT (FORMAT.md section 10), so it must be small,
 * closed and versioned: a filter written by a newer client has to be recognisable as such
 * by an older one, which then ignores it and says so rather than guessing. Two
 * interpreters run it — SQL over the derived read model for the table, JavaScript over
 * in-memory pages for the simulator and for tests — and they must agree. Everything that
 * could make them disagree is decided here, once: which operators a type allows, how an
 * invalid spec degrades, and how a relative date becomes an absolute one.
 *
 * Validation is strict at write time and lenient at read time, and the two differ on
 * purpose. A user saving a filter on a property that does not exist has made a mistake and
 * is told. A device READING a filter on a property another device deleted while it was
 * offline has not: both edits were valid locally, and the merge produced a dangling
 * reference. That is a normal state, not an exception, and the read-time rule for it is
 * chosen so that the only failure mode is "more rows than intended, with a warning".
 */

import {
  addDays,
  isCalendarDate,
  localDateOf,
  type CalendarDate,
  type OptionId,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
} from './properties.js';

export const QUERY_SPEC_VERSION = 1;

/** Fields every row has, sortable without a property. */
export type BuiltinField = 'title' | 'createdAt' | 'updatedAt';
export const BUILTIN_FIELDS: readonly BuiltinField[] = ['title', 'createdAt', 'updatedAt'];

/** An absolute day, or a day relative to "today" in the viewer's zone (0 today, -1 yesterday). */
export type DateOperand = { kind: 'on'; date: CalendarDate } | { kind: 'relative'; days: number };

export type TextOp = 'equals' | 'contains' | 'startsWith';
export type NumberOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type DateOp = 'onDate' | 'before' | 'after' | 'onOrBefore' | 'onOrAfter';

export type FilterLeaf =
  | { kind: 'leaf'; property: PropertyId; op: 'isEmpty' }
  | { kind: 'leaf'; property: PropertyId; op: TextOp; value: string }
  | { kind: 'leaf'; property: PropertyId; op: NumberOp; value: number }
  | { kind: 'leaf'; property: PropertyId; op: 'is'; value: boolean }
  | { kind: 'leaf'; property: PropertyId; op: 'optionIs' | 'optionIsNot'; value: OptionId }
  | { kind: 'leaf'; property: PropertyId; op: 'hasOption' | 'lacksOption'; value: OptionId }
  | { kind: 'leaf'; property: PropertyId; op: DateOp; value: DateOperand };

export type FilterOp = FilterLeaf['op'];

export type Filter =
  | { kind: 'and'; clauses: Filter[] }
  | { kind: 'or'; clauses: Filter[] }
  | { kind: 'not'; clause: Filter }
  | FilterLeaf;

/** What the view stores: the expression and the grammar version it was written under. */
export interface StoredFilter {
  v: number;
  expr: Filter;
}

export interface Sort {
  field: PropertyId | BuiltinField;
  direction: 'asc' | 'desc';
}

/** The query-relevant part of a view. */
export interface ViewSpec {
  filter?: StoredFilter;
  sorts: Sort[];
  /** Board columns. A select property only, in v0.3. */
  groupBy?: PropertyId;
}

/** Which operators each property type admits. The closed table both interpreters obey. */
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

/** Multi-select has no single value to order by; everything else does. */
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

export const MAX_FILTER_DEPTH = 8;
export const MAX_FILTER_LEAVES = 64;
/** A relative date further out than a century is a typo, not an intent. */
const MAX_RELATIVE_DAYS = 36_500;

export interface QueryProblem {
  /** Where in the spec, e.g. `filter.clauses[1]`, `sorts[0]`, `groupBy`. */
  path: string;
  code:
    | 'MALFORMED'
    | 'UNSUPPORTED_VERSION'
    | 'UNKNOWN_PROPERTY'
    | 'OP_NOT_ALLOWED'
    | 'BAD_OPERAND'
    | 'UNSORTABLE'
    | 'UNGROUPABLE'
    | 'TOO_DEEP'
    | 'TOO_MANY_LEAVES';
}

/** What "now" is, injected. Never `Date.now()` inside packages/. */
export interface QueryContext {
  nowMs: number;
  timeZone: string;
}

// ---- parsing untrusted stored JSON --------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDateOperand(raw: unknown): DateOperand | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'on' && typeof raw.date === 'string' && isCalendarDate(raw.date)) {
    return { kind: 'on', date: raw.date };
  }
  if (raw.kind === 'relative' && typeof raw.days === 'number' && Number.isSafeInteger(raw.days)) {
    return { kind: 'relative', days: raw.days };
  }
  return undefined;
}

/**
 * Structurally parse a filter that arrived from the CRDT, or undefined if it is not one.
 *
 * Checks shape only: that every node is a known kind with operands of the right
 * JavaScript type. Whether a property exists or an operator fits its type is a question
 * for `validateSpec` and `sanitiseSpec`, which need the schema.
 */
export function parseFilter(raw: unknown): Filter | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'and':
    case 'or': {
      if (!Array.isArray(raw.clauses)) return undefined;
      const clauses: Filter[] = [];
      for (const clause of raw.clauses) {
        const parsed = parseFilter(clause);
        if (parsed === undefined) return undefined;
        clauses.push(parsed);
      }
      return { kind: raw.kind, clauses };
    }
    case 'not': {
      const clause = parseFilter(raw.clause);
      return clause === undefined ? undefined : { kind: 'not', clause };
    }
    case 'leaf': {
      if (typeof raw.property !== 'string' || typeof raw.op !== 'string') return undefined;
      const property = raw.property as PropertyId;
      const op = raw.op;
      const value = raw.value;
      switch (op) {
        case 'isEmpty':
          return { kind: 'leaf', property, op };
        case 'equals':
        case 'contains':
        case 'startsWith':
          return typeof value === 'string' ? { kind: 'leaf', property, op, value } : undefined;
        case 'eq':
        case 'ne':
        case 'lt':
        case 'lte':
        case 'gt':
        case 'gte':
          return typeof value === 'number' ? { kind: 'leaf', property, op, value } : undefined;
        case 'is':
          return typeof value === 'boolean' ? { kind: 'leaf', property, op, value } : undefined;
        case 'optionIs':
        case 'optionIsNot':
        case 'hasOption':
        case 'lacksOption':
          return typeof value === 'string'
            ? { kind: 'leaf', property, op, value: value as OptionId }
            : undefined;
        case 'onDate':
        case 'before':
        case 'after':
        case 'onOrBefore':
        case 'onOrAfter': {
          const operand = parseDateOperand(value);
          return operand === undefined ? undefined : { kind: 'leaf', property, op, value: operand };
        }
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Parse a stored filter, or undefined when its shape is not one. */
export function parseStoredFilter(raw: unknown): StoredFilter | undefined {
  if (!isRecord(raw) || typeof raw.v !== 'number' || !Number.isSafeInteger(raw.v)) return undefined;
  const expr = parseFilter(raw.expr);
  return expr === undefined ? undefined : { v: raw.v, expr };
}

// ---- walking ---------------------------------------------------------------------

/** Every leaf in a filter, depth first. */
export function filterLeaves(filter: Filter): FilterLeaf[] {
  switch (filter.kind) {
    case 'leaf':
      return [filter];
    case 'not':
      return filterLeaves(filter.clause);
    default:
      return filter.clauses.flatMap(filterLeaves);
  }
}

function depthOf(filter: Filter): number {
  switch (filter.kind) {
    case 'leaf':
      return 1;
    case 'not':
      return 1 + depthOf(filter.clause);
    default:
      return 1 + Math.max(0, ...filter.clauses.map(depthOf));
  }
}

// ---- validation -------------------------------------------------------------------

/**
 * Problems with one leaf against the schema.
 *
 * `strict` is the write-time rule: a select operand must name an option the property
 * has. At read time it may not — the option can have been removed on another device —
 * and a leaf that names a missing option simply matches nothing, so the filter survives.
 */
function leafProblems(
  leaf: FilterLeaf,
  path: string,
  defs: ReadonlyMap<string, PropertyDef>,
  strict: boolean,
): QueryProblem[] {
  const def = defs.get(leaf.property);
  if (def === undefined) return [{ path, code: 'UNKNOWN_PROPERTY' }];
  if (!OPS_BY_TYPE[def.type].includes(leaf.op)) return [{ path, code: 'OP_NOT_ALLOWED' }];
  switch (leaf.op) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return Number.isFinite(leaf.value) ? [] : [{ path, code: 'BAD_OPERAND' }];
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption':
      if (strict && !def.options.some((o) => o.id === leaf.value)) {
        return [{ path, code: 'BAD_OPERAND' }];
      }
      return [];
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      const operand = leaf.value;
      if (operand.kind === 'on')
        return isCalendarDate(operand.date) ? [] : [{ path, code: 'BAD_OPERAND' }];
      return Math.abs(operand.days) <= MAX_RELATIVE_DAYS ? [] : [{ path, code: 'BAD_OPERAND' }];
    }
    default:
      return [];
  }
}

function filterProblems(
  filter: Filter,
  path: string,
  defs: ReadonlyMap<string, PropertyDef>,
  strict: boolean,
): QueryProblem[] {
  switch (filter.kind) {
    case 'leaf':
      return leafProblems(filter, path, defs, strict);
    case 'not':
      return filterProblems(filter.clause, `${path}.clause`, defs, strict);
    default:
      return filter.clauses.flatMap((clause, i) =>
        filterProblems(clause, `${path}.clauses[${String(i)}]`, defs, strict),
      );
  }
}

function storedFilterProblems(
  stored: StoredFilter,
  defs: ReadonlyMap<string, PropertyDef>,
  strict: boolean,
): QueryProblem[] {
  if (stored.v > QUERY_SPEC_VERSION) return [{ path: 'filter', code: 'UNSUPPORTED_VERSION' }];
  if (depthOf(stored.expr) > MAX_FILTER_DEPTH) return [{ path: 'filter', code: 'TOO_DEEP' }];
  if (filterLeaves(stored.expr).length > MAX_FILTER_LEAVES) {
    return [{ path: 'filter', code: 'TOO_MANY_LEAVES' }];
  }
  return filterProblems(stored.expr, 'filter', defs, strict);
}

function sortProblem(
  sort: Sort,
  path: string,
  defs: ReadonlyMap<string, PropertyDef>,
): QueryProblem | undefined {
  if ((BUILTIN_FIELDS as readonly string[]).includes(sort.field)) return undefined;
  const def = defs.get(sort.field);
  if (def === undefined) return { path, code: 'UNKNOWN_PROPERTY' };
  return SORTABLE_TYPES.includes(def.type) ? undefined : { path, code: 'UNSORTABLE' };
}

function groupProblem(
  groupBy: PropertyId,
  defs: ReadonlyMap<string, PropertyDef>,
): QueryProblem | undefined {
  const def = defs.get(groupBy);
  if (def === undefined) return { path: 'groupBy', code: 'UNKNOWN_PROPERTY' };
  return GROUPABLE_TYPES.includes(def.type) ? undefined : { path: 'groupBy', code: 'UNGROUPABLE' };
}

function byId(defs: readonly PropertyDef[]): ReadonlyMap<string, PropertyDef> {
  return new Map(defs.map((def) => [def.id, def]));
}

/**
 * Every problem with a spec, for the write path. An empty list means it may be stored.
 *
 * Strict: a select operand must name an existing option, and a filter version above
 * this client's is refused — a client must never rewrite what it does not understand.
 */
export function validateSpec(defs: readonly PropertyDef[], spec: ViewSpec): QueryProblem[] {
  const index = byId(defs);
  const problems: QueryProblem[] = [];
  if (spec.filter !== undefined) problems.push(...storedFilterProblems(spec.filter, index, true));
  spec.sorts.forEach((sort, i) => {
    const problem = sortProblem(sort, `sorts[${String(i)}]`, index);
    if (problem !== undefined) problems.push(problem);
  });
  if (spec.groupBy !== undefined) {
    const problem = groupProblem(spec.groupBy, index);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

/**
 * The spec both interpreters actually run, for the read path, with what was dropped.
 *
 * Any problem inside the filter drops the WHOLE filter. Forcing a bad leaf to `true`
 * would hide every row under a `not`; dropping one leaf inside an `or` shows fewer rows
 * than intended while looking healthy. Dropping the filter is the only choice whose
 * failure mode is always "more rows than intended, with a visible warning", and it needs
 * no per-node case analysis to keep two interpreters identical. Invalid sorts are dropped
 * one by one, since dropping a sort never hides a row. An invalid group ungroups.
 */
export function sanitiseSpec(
  defs: readonly PropertyDef[],
  spec: ViewSpec,
): { spec: ViewSpec; warnings: QueryProblem[] } {
  const index = byId(defs);
  const warnings: QueryProblem[] = [];
  const out: ViewSpec = { sorts: [] };

  if (spec.filter !== undefined) {
    const problems = storedFilterProblems(spec.filter, index, false);
    if (problems.length === 0) out.filter = spec.filter;
    else warnings.push(...problems);
  }
  spec.sorts.forEach((sort, i) => {
    const problem = sortProblem(sort, `sorts[${String(i)}]`, index);
    if (problem === undefined) out.sorts.push(sort);
    else warnings.push(problem);
  });
  if (spec.groupBy !== undefined) {
    const problem = groupProblem(spec.groupBy, index);
    if (problem === undefined) out.groupBy = spec.groupBy;
    else warnings.push(problem);
  }
  return { spec: out, warnings };
}

// ---- rewriting ---------------------------------------------------------------------

/**
 * Replace every relative date with the absolute day it means right now, in the
 * viewer's zone. Run once, before either interpreter, so both see the same days.
 */
export function resolveDates(filter: Filter, ctx: QueryContext): Filter {
  switch (filter.kind) {
    case 'and':
    case 'or':
      return { kind: filter.kind, clauses: filter.clauses.map((c) => resolveDates(c, ctx)) };
    case 'not':
      return { kind: 'not', clause: resolveDates(filter.clause, ctx) };
    case 'leaf':
      switch (filter.op) {
        case 'onDate':
        case 'before':
        case 'after':
        case 'onOrBefore':
        case 'onOrAfter':
          if (filter.value.kind === 'relative') {
            const today = localDateOf(ctx.nowMs, ctx.timeZone);
            return { ...filter, value: { kind: 'on', date: addDays(today, filter.value.days) } };
          }
          return filter;
        default:
          return filter;
      }
  }
}

/**
 * The filter with every leaf on a property removed, or undefined if nothing is left.
 *
 * Used when a property is removed locally, so the user's own action does not degrade
 * their own view to "unfiltered with a warning". A conjunction losing a clause matches
 * more; a disjunction losing a clause matches less; a `not` losing its clause vanishes.
 */
export function stripProperty(filter: Filter, property: PropertyId): Filter | undefined {
  switch (filter.kind) {
    case 'leaf':
      return filter.property === property ? undefined : filter;
    case 'not': {
      const clause = stripProperty(filter.clause, property);
      return clause === undefined ? undefined : { kind: 'not', clause };
    }
    default: {
      const clauses = filter.clauses
        .map((c) => stripProperty(c, property))
        .filter((c): c is Filter => c !== undefined);
      return clauses.length === 0 ? undefined : { kind: filter.kind, clauses };
    }
  }
}
