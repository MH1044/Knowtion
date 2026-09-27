/**
 * Reading a database's schema out of its page's node data.
 *
 * ADR-0014 and FORMAT.md section 10.1 fix the layout: a database is a page whose node
 * carries a `db` map holding `props`, `options` and `views`; its rows are its children,
 * each carrying `props` (values) and `order` (per-view position) on their own nodes.
 * Every one of those maps is a mergeable child, created with `ensureMergeable*`, never
 * `setContainer` — the spike test in this package shows why.
 *
 * This module is the pure half: it turns the JSON `node.data.toJSON()` yields into typed
 * schema objects, following the possibly-absent convention every reader of node data
 * follows. Anything malformed is skipped, never rewritten. The Loro-touching half is in
 * workspace.ts.
 */

import { isUuid } from './ids.js';
import { isOrderKey, type OrderKey } from './order-key.js';
import {
  decodePropertyValue,
  isOptionColour,
  isPropertyType,
  type OptionId,
  type PropertyConfig,
  type PropertyDef,
  type PropertyId,
  type PropertyValue,
  type SelectOption,
  type ViewId,
} from './properties.js';
import { decodeView, type ViewDef } from './views.js';

/** Keys on a node's data map. Permanent, per FORMAT.md section 10.1. */
export const DB_KEY = 'db';
export const DB_RETIRED_KEY = 'retired';
export const DB_PROPS_KEY = 'props';
export const DB_OPTIONS_KEY = 'options';
export const DB_VIEWS_KEY = 'views';
export const ROW_PROPS_KEY = 'props';
export const ROW_ORDER_KEY = 'order';

export interface DatabaseSchema {
  createdAt: number;
  /** In creation order: ids are UUIDv7 and sort by time. */
  properties: PropertyDef[];
  /** In creation order, for the same reason. */
  views: ViewDef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The config a property of this type needs, or undefined when it has none or the stored
 * one cannot be read.
 *
 * The caller distinguishes the two: a type that needs no config is fine without one, and
 * a type that needs one is dropped from the schema without it. Nothing is repaired here.
 *
 * Exported because a retype has to read it. A property retyped away from `relation`
 * keeps its config in the log but not in the decoded schema, which is the whole point of
 * a retype hiding rather than destroying; retyping back has to look at the log to find
 * the target again.
 */
export function decodeConfig(type: PropertyDef['type'], raw: unknown): PropertyConfig | undefined {
  switch (type) {
    case 'text':
    case 'number':
    case 'checkbox':
    case 'select':
    case 'multi-select':
    case 'date':
    case 'datetime':
    case 'url':
      return undefined;
    case 'relation':
      if (!isRecord(raw) || !isUuid(raw.database)) return undefined;
      return { database: raw.database };
  }
}

/** Types whose property is meaningless, and so unreadable, without a config. */
function needsConfig(type: PropertyDef['type']): boolean {
  return type === 'relation';
}

/**
 * A row's values, as its parent's schema reads them. Unknown property ids and values of
 * the wrong shape are left out, never touched.
 */
export function decodeRowValues(
  schema: DatabaseSchema,
  raw: unknown,
): Record<PropertyId, PropertyValue> {
  const out: Record<PropertyId, PropertyValue> = {};
  if (!isRecord(raw)) return out;
  for (const property of schema.properties) {
    const value = decodePropertyValue(property, raw[property.id]);
    if (value !== undefined) out[property.id] = value;
  }
  return out;
}

/** A row's per-view positions, for the views the parent still has. Malformed keys are ignored. */
export function decodeRowOrder(schema: DatabaseSchema, raw: unknown): Record<ViewId, OrderKey> {
  const out: Record<ViewId, OrderKey> = {};
  if (!isRecord(raw)) return out;
  for (const view of schema.views) {
    const key = raw[view.id];
    if (typeof key === 'string' && isOrderKey(key)) out[view.id] = key;
  }
  return out;
}

/** The option key inside `db.options`: one level, so two devices renaming different options both win. */
export function optionKey(property: PropertyId, option: OptionId): string {
  return `${property}:${option}`;
}

function decodeOptions(raw: unknown, properties: Map<string, PropertyDef>): void {
  if (!isRecord(raw)) return;
  for (const [key, value] of Object.entries(raw)) {
    const colon = key.indexOf(':');
    if (colon < 0) continue;
    const propertyId = key.slice(0, colon);
    const optionId = key.slice(colon + 1);
    const property = properties.get(propertyId);
    if (property === undefined || !isUuid(optionId)) continue;
    if (property.type !== 'select' && property.type !== 'multi-select') continue;
    if (!isRecord(value) || typeof value.name !== 'string') continue;
    const option: SelectOption = {
      id: optionId,
      name: value.name,
      ...(isOptionColour(value.color) ? { color: value.color } : {}),
    };
    property.options.push(option);
  }
  for (const property of properties.values()) property.options.sort(byId);
}

/**
 * The schema a `db` map denotes, or undefined when the value is not a database at all.
 *
 * A property with an unknown type is skipped — a newer client defined it — and stays in
 * the log for that client. Options belong to select properties only; under any other
 * type they are kept but not shown, so a retype back restores them.
 *
 * A retired database reads as no database at all (ADR-0016). Everything under `db` stays
 * exactly where it is, which is what lets the page become a database again with its
 * schema, its views and every row's values intact.
 */
export function decodeDatabaseSchema(raw: unknown): DatabaseSchema | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw[DB_RETIRED_KEY] === true) return undefined;

  const properties = new Map<string, PropertyDef>();
  if (isRecord(raw[DB_PROPS_KEY])) {
    for (const [id, value] of Object.entries(raw[DB_PROPS_KEY])) {
      if (!isUuid(id) || !isRecord(value)) continue;
      if (typeof value.name !== 'string' || !isPropertyType(value.type)) continue;
      const config = decodeConfig(value.type, value.config);
      // A relation with no readable target is not a property this build can present. It
      // is left in the log untouched, exactly like a property of a type this build does
      // not know: a client that understands it still sees it.
      if (config === undefined && needsConfig(value.type)) continue;
      properties.set(id, {
        id,
        name: value.name,
        type: value.type,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        options: [],
        ...(config === undefined ? {} : { config }),
      });
    }
  }
  decodeOptions(raw[DB_OPTIONS_KEY], properties);
  const sortedProperties = [...properties.values()].sort(byId);

  const views: ViewDef[] = [];
  if (isRecord(raw[DB_VIEWS_KEY])) {
    for (const [id, value] of Object.entries(raw[DB_VIEWS_KEY])) {
      if (!isUuid(id)) continue;
      const view = decodeView(id, value, sortedProperties);
      if (view !== undefined) views.push(view);
    }
  }
  views.sort(byId);

  return {
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    properties: sortedProperties,
    views,
  };
}
