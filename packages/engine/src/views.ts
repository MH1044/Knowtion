/**
 * A view: how a database is looked at. Table or board, filtered, sorted, grouped.
 *
 * FORMAT.md section 10 splits view configuration in two. What is here — name, type,
 * filter, sorts, group, column order, hidden columns — is semantics and lives in the
 * CRDT under `db.views.<viewId>` on the database page's node, each field its own key so
 * two devices editing different aspects of one view both survive. Scroll position,
 * collapsed groups and column pixel widths are ephemera and never come near this file.
 *
 * Reading is lenient in the possibly-absent style every reader of node data follows: a
 * view of a type this client does not know is omitted (never deleted), a filter that
 * fails to parse reads as no filter, and columns naming a property that no longer exists
 * are dropped. The effective column order is the stored order followed by every live
 * property missing from it — so a property defined on another device can never be hidden
 * by a lost array write; `hidden` is the only way a property leaves a view.
 */

import type { PropertyDef, PropertyId, ViewId } from './properties.js';
import {
  BUILTIN_FIELDS,
  parseStoredFilter,
  type Sort,
  type StoredFilter,
  type ViewSpec,
} from './query.js';

export const VIEW_TYPES = ['table', 'board'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export interface ViewDef {
  id: ViewId;
  name: string;
  type: ViewType;
  filter?: StoredFilter;
  sorts: Sort[];
  /** Board columns. A select property, in v0.3. */
  groupBy?: PropertyId;
  /** Effective column order: stored order, then every live property missing from it. */
  columns: PropertyId[];
  /** Properties this view does not show. */
  hidden: PropertyId[];
  createdAt: number;
}

export function isViewType(value: unknown): value is ViewType {
  return typeof value === 'string' && (VIEW_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function decodeSorts(raw: unknown, live: ReadonlySet<string>): Sort[] {
  if (!Array.isArray(raw)) return [];
  const out: Sort[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.field !== 'string') continue;
    if (entry.direction !== 'asc' && entry.direction !== 'desc') continue;
    const builtin = (BUILTIN_FIELDS as readonly string[]).includes(entry.field);
    if (!builtin && !live.has(entry.field)) continue;
    out.push({ field: entry.field as Sort['field'], direction: entry.direction });
  }
  return out;
}

/**
 * Read one view from its stored map, given the database's live properties.
 *
 * Returns undefined for a view this client cannot show at all — an unknown type. Every
 * other defect degrades field by field.
 */
export function decodeView(
  id: ViewId,
  raw: unknown,
  properties: readonly PropertyDef[],
): ViewDef | undefined {
  if (!isRecord(raw) || !isViewType(raw.type)) return undefined;
  const live = new Set<string>(properties.map((p) => p.id));

  const storedColumns = stringList(raw.columns).filter((c) => live.has(c));
  const hidden = [...new Set(stringList(raw.hidden).filter((c) => live.has(c)))] as PropertyId[];
  const columns = [...new Set(storedColumns)] as PropertyId[];
  for (const property of properties) if (!columns.includes(property.id)) columns.push(property.id);

  const groupBy =
    typeof raw.groupBy === 'string' &&
    properties.some((p) => p.id === raw.groupBy && p.type === 'select')
      ? (raw.groupBy as PropertyId)
      : undefined;
  const filter =
    raw.filter === undefined || raw.filter === null ? undefined : parseStoredFilter(raw.filter);

  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: raw.type,
    ...(filter === undefined ? {} : { filter }),
    sorts: decodeSorts(raw.sorts, live),
    ...(groupBy === undefined ? {} : { groupBy }),
    columns,
    hidden,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  };
}

/** The part of a view the interpreters run. */
export function viewSpecOf(view: ViewDef): ViewSpec {
  return {
    ...(view.filter === undefined ? {} : { filter: view.filter }),
    sorts: view.sorts,
    ...(view.groupBy === undefined ? {} : { groupBy: view.groupBy }),
  };
}
