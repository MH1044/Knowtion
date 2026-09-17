/**
 * The SQL interpreter of a view: compile a spec into one parameterised SELECT.
 *
 * The other interpreter is the engine's `evaluateQuery`, and the two must agree on every
 * row. Three rules keep them aligned by construction:
 *
 * 1. Every filter leaf compiles to `exists(...)` or `not exists(...)` over the value
 *    tables. No raw column comparison ever reaches the WHERE clause, so SQL's three-valued
 *    NULL logic never enters: a positive operator on an empty cell is false, and the
 *    negations (`ne`, `optionIsNot`, `lacksOption`) are `not exists`, so empty cells match
 *    them — exactly the JavaScript rule.
 * 2. Comparisons run over the columns the projection filled with the engine's own
 *    outputs: folded text, the calendar date of an instant in its zone, an option's
 *    position. SQL never re-derives a rule.
 * 3. Values from the user reach SQLite only as positional parameters. Column names and
 *    directions come from closed tables keyed by property type, never from a spec.
 *
 * Ordering mirrors `compareRows`: each sort places empties last in both directions by
 * ordering on `(column is null)` first, then the column under BINARY collation; the
 * tie-break is manual order (keyed rows first), then creation time, then id.
 */

import {
  foldText,
  type Filter,
  type FilterLeaf,
  type PropertyDef,
  type Sort,
  type ViewSpec,
} from '@knowtion/engine';

export type SqlParam = string | number | null;

export interface CompiledQuery {
  sql: string;
  params: SqlParam[];
  countSql: string;
  countParams: SqlParam[];
}

export interface CompileInput {
  databaseId: string;
  /** When given, the view's manual order joins in and breaks ties. */
  viewId?: string;
  defs: readonly PropertyDef[];
  /** Already sanitised and with relative dates resolved; the read model does both first. */
  spec: ViewSpec;
  includeArchived: boolean;
  limit?: number;
  offset?: number;
}

/** A SQL fragment with the parameters it consumes, in order. */
interface Fragment {
  sql: string;
  params: SqlParam[];
}

/**
 * A value row for the property, of the kind the schema says. The kind check makes the
 * emptiness rule robust: a value of another shape is empty, as the evaluator has it.
 */
const VALUE_ROW =
  'select 1 from property_value v where v.page_id = r.id and v.property_id = ? and v.kind = ?';
const ITEM_ROW =
  'select 1 from property_value_item i where i.page_id = r.id and i.property_id = ? and i.option_id = ?';

const NUMBER_OPS: Record<'eq' | 'lt' | 'lte' | 'gt' | 'gte', string> = {
  eq: '=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

const DATE_OPS: Record<'onDate' | 'before' | 'after' | 'onOrBefore' | 'onOrAfter', string> = {
  onDate: '=',
  before: '<',
  after: '>',
  onOrBefore: '<=',
  onOrAfter: '>=',
};

function exists(where: string, params: SqlParam[]): Fragment {
  return { sql: `exists(${VALUE_ROW} and ${where})`, params };
}

function notExists(where: string, params: SqlParam[]): Fragment {
  return { sql: `not exists(${VALUE_ROW} and ${where})`, params };
}

function compileLeaf(leaf: FilterLeaf, defs: ReadonlyMap<string, PropertyDef>): Fragment {
  const def = defs.get(leaf.property);
  // The spec was sanitised, so this is unreachable; the evaluator answers false too.
  if (def === undefined) return { sql: '0', params: [] };
  const property: SqlParam[] = [leaf.property, def.type];

  switch (leaf.op) {
    case 'isEmpty':
      return { sql: `not exists(${VALUE_ROW})`, params: property };
    case 'equals':
      return exists('v.text_fold = ?', [...property, foldText(leaf.value)]);
    case 'contains':
      return exists('instr(v.text_fold, ?) > 0', [...property, foldText(leaf.value)]);
    case 'startsWith':
      return exists('instr(v.text_fold, ?) = 1', [...property, foldText(leaf.value)]);
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return exists(`v.num_value ${NUMBER_OPS[leaf.op]} ?`, [...property, leaf.value]);
    case 'ne':
      return notExists('v.num_value = ?', [...property, leaf.value]);
    case 'is':
      return leaf.value
        ? exists('v.int_value = 1', property)
        : notExists('v.int_value = 1', property);
    case 'optionIs':
      return exists('v.text_value = ?', [...property, leaf.value]);
    case 'optionIsNot':
      return notExists('v.text_value = ?', [...property, leaf.value]);
    case 'hasOption':
      return { sql: `exists(${ITEM_ROW})`, params: [leaf.property, leaf.value] };
    case 'lacksOption':
      return { sql: `not exists(${ITEM_ROW})`, params: [leaf.property, leaf.value] };
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      // A relative operand was resolved before compiling; one that was not matches nothing,
      // as the evaluator's does.
      if (leaf.value.kind !== 'on') return { sql: '0', params: [] };
      return exists(`v.text_value ${DATE_OPS[leaf.op]} ?`, [...property, leaf.value.date]);
    }
  }
}

function compileFilter(filter: Filter, defs: ReadonlyMap<string, PropertyDef>): Fragment {
  switch (filter.kind) {
    case 'and':
    case 'or': {
      if (filter.clauses.length === 0)
        return { sql: filter.kind === 'and' ? '1' : '0', params: [] };
      const parts = filter.clauses.map((c) => compileFilter(c, defs));
      return {
        sql: `(${parts.map((p) => p.sql).join(filter.kind === 'and' ? ' and ' : ' or ')})`,
        params: parts.flatMap((p) => p.params),
      };
    }
    case 'not': {
      const inner = compileFilter(filter.clause, defs);
      return { sql: `(not ${inner.sql})`, params: inner.params };
    }
    case 'leaf':
      return compileLeaf(filter, defs);
  }
}

/** The join and ORDER BY terms one sort contributes. */
function compileSort(
  sort: Sort,
  index: number,
  defs: ReadonlyMap<string, PropertyDef>,
  databaseId: string,
): { joins: Fragment[]; order: string[] } {
  const dir = sort.direction === 'desc' ? 'desc' : 'asc';
  switch (sort.field) {
    case 'title':
      return {
        joins: [],
        order: [`r.title_fold collate binary ${dir}`, `r.title collate binary ${dir}`],
      };
    case 'createdAt':
      return { joins: [], order: [`r.created_at ${dir}`] };
    case 'updatedAt':
      return { joins: [], order: [`r.updated_at ${dir}`] };
    default: {
      const def = defs.get(sort.field);
      if (def === undefined) return { joins: [], order: [] };
      const s = `s${String(index)}`;
      const join: Fragment = {
        sql: `left join property_value ${s} on ${s}.page_id = r.id and ${s}.property_id = ? and ${s}.kind = ?`,
        params: [sort.field, def.type],
      };
      switch (def.type) {
        case 'text':
        case 'url':
          return {
            joins: [join],
            order: [
              `(${s}.text_fold is null)`,
              `${s}.text_fold collate binary ${dir}`,
              `${s}.text_value collate binary ${dir}`,
            ],
          };
        case 'number':
          return { joins: [join], order: [`(${s}.num_value is null)`, `${s}.num_value ${dir}`] };
        case 'checkbox':
          // Absent is unchecked, never empty.
          return { joins: [join], order: [`coalesce(${s}.int_value, 0) ${dir}`] };
        case 'select': {
          const o = `o${String(index)}`;
          return {
            joins: [
              join,
              {
                sql: `left join property_option ${o} on ${o}.database_id = ? and ${o}.property_id = ? and ${o}.option_id = ${s}.text_value`,
                params: [databaseId, sort.field],
              },
            ],
            order: [`(${o}.position is null)`, `${o}.position ${dir}`],
          };
        }
        case 'date':
          return {
            joins: [join],
            order: [`(${s}.text_value is null)`, `${s}.text_value collate binary ${dir}`],
          };
        case 'datetime':
          return { joins: [join], order: [`(${s}.int_value is null)`, `${s}.int_value ${dir}`] };
        case 'multi-select':
          return { joins: [join], order: [] }; // unsortable; sanitising never lets one through
      }
    }
  }
}

export function compileQuery(input: CompileInput): CompiledQuery {
  const defs = new Map(input.defs.map((d) => [d.id, d]));
  const joins: Fragment[] = [];
  const order: string[] = [];
  const select = [
    'r.id',
    'r.uuid',
    'r.title',
    'r.created_at as createdAt',
    'r.updated_at as updatedAt',
    'r.row_json as rowJson',
  ];

  if (input.viewId !== undefined) {
    joins.push({
      sql: 'left join row_order ro on ro.view_id = ? and ro.page_id = r.id',
      params: [input.viewId],
    });
    select.push('ro.order_key as orderKey');
  } else {
    select.push('null as orderKey');
  }

  input.spec.sorts.forEach((sort, index) => {
    const compiled = compileSort(sort, index, defs, input.databaseId);
    joins.push(...compiled.joins);
    order.push(...compiled.order);
  });

  if (input.spec.groupBy !== undefined) {
    // The bucket key is the option id if the option still exists, else null — which is
    // what the evaluator's groupKeyOf answers for a dangling id.
    joins.push({
      sql: 'left join property_value sg on sg.page_id = r.id and sg.property_id = ? and sg.kind = ?',
      params: [input.spec.groupBy, 'select'],
    });
    joins.push({
      sql: 'left join property_option og on og.database_id = ? and og.property_id = ? and og.option_id = sg.text_value',
      params: [input.databaseId, input.spec.groupBy],
    });
    select.push('og.option_id as groupKey');
  } else {
    select.push('null as groupKey');
  }

  const where: Fragment[] = [{ sql: 'r.parent_id = ?', params: [input.databaseId] }];
  if (!input.includeArchived) where.push({ sql: 'r.archived_at is null', params: [] });
  if (input.spec.filter !== undefined) where.push(compileFilter(input.spec.filter.expr, defs));

  // The tie-break every view shares. Manual order only when a view is in play.
  if (input.viewId !== undefined) {
    order.push('(ro.order_key is null)', 'ro.order_key collate binary asc');
  }
  order.push('r.created_at asc', 'r.id collate binary asc');

  const fromClause = ['page r', ...joins.map((j) => j.sql)].join('\n  ');
  const whereClause = where.map((w) => w.sql).join('\n  and ');
  const baseParams: SqlParam[] = [
    ...joins.flatMap((j) => j.params),
    ...where.flatMap((w) => w.params),
  ];

  let sql = `select ${select.join(', ')}\nfrom ${fromClause}\nwhere ${whereClause}\norder by ${order.join(', ')}`;
  const params = [...baseParams];
  if (input.limit !== undefined) {
    sql += '\nlimit ?';
    params.push(input.limit);
    if (input.offset !== undefined) {
      sql += ' offset ?';
      params.push(input.offset);
    }
  }

  // Counting needs only the filter, not the sort joins.
  const countSql = `select count(*) as total\nfrom page r\nwhere ${whereClause}`;
  const countParams = where.flatMap((w) => w.params);

  return { sql, params, countSql, countParams };
}
