/**
 * The database types as the renderer sees them.
 *
 * The renderer must not import @knowtion/engine or @knowtion/readmodel — both load
 * node:sqlite, and the bridge exists to keep the database layer out of the sandbox — so
 * their domain types are redeclared here with identifiers widened to plain strings. This
 * file has no DOM references, so it compiles under both the renderer's and the main
 * process's tsconfig; a test on the main side asserts the engine's types are assignable
 * to these mirrors, which turns silent drift into a typecheck failure.
 *
 * Every shape mirrors one in packages/engine/src (properties.ts, query.ts, views.ts,
 * database.ts, types.ts) or packages/readmodel/src/read-model.ts. Change those first.
 */

export type PropertyType =
  'text' | 'number' | 'checkbox' | 'select' | 'multi-select' | 'date' | 'datetime' | 'url';

export type OptionColour =
  'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

export interface SelectOption {
  id: string;
  name: string;
  color?: OptionColour;
}

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  createdAt: number;
  /** Always present; empty unless the type is select or multi-select. */
  options: SelectOption[];
}

export type PropertyValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'checkbox'; value: boolean }
  | { type: 'select'; value: string }
  | { type: 'multi-select'; value: string[] }
  /** `YYYY-MM-DD`, zoneless. Never build a Date from it: that is how a day goes missing. */
  | { type: 'date'; value: string }
  | { type: 'datetime'; value: { ms: number; zone: string } }
  | { type: 'url'; value: string };

export type DateOperand = { kind: 'on'; date: string } | { kind: 'relative'; days: number };

export type FilterLeaf =
  | { kind: 'leaf'; property: string; op: 'isEmpty' }
  | { kind: 'leaf'; property: string; op: 'equals' | 'contains' | 'startsWith'; value: string }
  | {
      kind: 'leaf';
      property: string;
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      value: number;
    }
  | { kind: 'leaf'; property: string; op: 'is'; value: boolean }
  | { kind: 'leaf'; property: string; op: 'optionIs' | 'optionIsNot'; value: string }
  | { kind: 'leaf'; property: string; op: 'hasOption' | 'lacksOption'; value: string }
  | {
      kind: 'leaf';
      property: string;
      op: 'onDate' | 'before' | 'after' | 'onOrBefore' | 'onOrAfter';
      value: DateOperand;
    };

export type Filter =
  | { kind: 'and'; clauses: Filter[] }
  | { kind: 'or'; clauses: Filter[] }
  | { kind: 'not'; clause: Filter }
  | FilterLeaf;

export interface StoredFilter {
  v: number;
  expr: Filter;
}

export interface Sort {
  /** A property id, or one of the built-ins: title, createdAt, updatedAt. */
  field: string;
  direction: 'asc' | 'desc';
}

export type ViewType = 'table' | 'board';

export interface ViewDef {
  id: string;
  name: string;
  type: ViewType;
  filter?: StoredFilter;
  sorts: Sort[];
  groupBy?: string;
  /** Effective column order: every live property appears here. */
  columns: string[];
  hidden: string[];
  createdAt: number;
}

export interface DatabaseSchema {
  createdAt: number;
  properties: PropertyDef[];
  views: ViewDef[];
}

export type RowPosition =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'before'; row: string }
  | { kind: 'after'; row: string };

export interface RowView {
  id: string;
  uuid: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  values: Record<string, PropertyValue>;
  orderKey?: string;
}

export interface QueryProblem {
  path: string;
  code: string;
}

export interface QueryResult {
  rows: RowView[];
  total: number;
  warnings: QueryProblem[];
  groups?: { key: string | null; rows: RowView[] }[];
}

/** Unsaved toolbar edits laid over a stored view for a preview query. */
export interface ViewOverrides {
  filter?: StoredFilter | null;
  sorts?: Sort[];
  groupBy?: string | null;
}

export interface ViewQuery {
  databaseId: string;
  viewId: string;
  overrides?: ViewOverrides;
  limit?: number;
  offset?: number;
}

/** The filter spec version the renderer writes. Mirrors the engine; the drift test checks it. */
export const QUERY_SPEC_VERSION = 1;
