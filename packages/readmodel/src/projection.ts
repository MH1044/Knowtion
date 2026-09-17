/**
 * Projecting databases into SQLite: definitions, values, membership and manual order.
 *
 * The read model is derived, so these functions only ever write what the engine already
 * decided. A cell is stored in the typed column its kind names; text carries the engine's
 * folded form beside the raw one; a datetime carries the calendar date of its instant in
 * its own zone. Those are the OUTPUTS of the engine's shared semantic functions, stored so
 * the SQL compiler compares exactly what the JavaScript evaluator compares. Nothing here
 * re-derives a rule.
 *
 * Definitions are small and fully replaced. Values are rewritten per page, and only when
 * the page's canonical fingerprint changed — a pure function of the Page, which is what
 * keeps an incrementally maintained store identical to one rebuilt from scratch.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  foldText,
  localDateOf,
  type Page,
  type PropertyDef,
  type PropertyValue,
  type ViewDef,
} from '@knowtion/engine';

/** Every projected table, for the rebuild-equivalence gate. Ordered by primary key. */
export interface ProjectionContents {
  pages: {
    id: string;
    title: string;
    body: string;
    parentId: string | null;
    createdAt: number;
    isDatabase: number;
    rowJson: string;
  }[];
  propertyDefs: { databaseId: string; propertyId: string; position: number; defJson: string }[];
  propertyOptions: {
    databaseId: string;
    propertyId: string;
    optionId: string;
    name: string;
    position: number;
  }[];
  views: { databaseId: string; viewId: string; position: number; viewJson: string }[];
  propertyValues: {
    pageId: string;
    propertyId: string;
    kind: string;
    textValue: string | null;
    textFold: string | null;
    numValue: number | null;
    intValue: number | null;
    jsonValue: string | null;
  }[];
  items: { pageId: string; propertyId: string; optionId: string; position: number }[];
  rowOrder: { viewId: string; pageId: string; orderKey: string }[];
}

/** Stable JSON for a definition: keys in a fixed order, so equal definitions are equal text. */
function definitionJson(def: PropertyDef): string {
  return JSON.stringify({
    id: def.id,
    name: def.name,
    type: def.type,
    createdAt: def.createdAt,
    options: def.options.map((o) => ({
      id: o.id,
      name: o.name,
      ...(o.color === undefined ? {} : { color: o.color }),
    })),
  });
}

function viewJson(view: ViewDef): string {
  return JSON.stringify({
    id: view.id,
    name: view.name,
    type: view.type,
    ...(view.filter === undefined ? {} : { filter: view.filter }),
    sorts: view.sorts,
    ...(view.groupBy === undefined ? {} : { groupBy: view.groupBy }),
    columns: view.columns,
    hidden: view.hidden,
    createdAt: view.createdAt,
  });
}

/** Replace one database's definitions. Deletes what was there first. */
export function writeDatabaseDefinitions(db: DatabaseSync, page: Page): void {
  const schema = page.database;
  db.prepare('delete from property_def where database_id = ?').run(page.id);
  db.prepare('delete from property_option where database_id = ?').run(page.id);
  db.prepare('delete from view_def where database_id = ?').run(page.id);
  if (schema === undefined) return;

  const insertDef = db.prepare(
    `insert into property_def(database_id, property_id, name, type, position, def_json)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const insertOption = db.prepare(
    `insert into property_option(database_id, property_id, option_id, name, position)
     values (?, ?, ?, ?, ?)`,
  );
  const insertView = db.prepare(
    `insert into view_def(database_id, view_id, name, type, position, view_json)
     values (?, ?, ?, ?, ?, ?)`,
  );
  schema.properties.forEach((def, position) => {
    insertDef.run(page.id, def.id, def.name, def.type, position, definitionJson(def));
    def.options.forEach((option, optionPosition) => {
      insertOption.run(page.id, def.id, option.id, option.name, optionPosition);
    });
  });
  schema.views.forEach((view, position) => {
    insertView.run(page.id, view.id, view.name, view.type, position, viewJson(view));
  });
}

/** The typed columns a value occupies. Exactly one carries it; the rest are null. */
function columnsOf(value: PropertyValue): {
  text: string | null;
  fold: string | null;
  num: number | null;
  int: number | null;
  json: string | null;
} {
  const empty = { text: null, fold: null, num: null, int: null, json: null };
  switch (value.type) {
    case 'text':
    case 'url':
      return { ...empty, text: value.value, fold: foldText(value.value) };
    case 'number':
      return { ...empty, num: value.value };
    case 'checkbox':
      return { ...empty, int: value.value ? 1 : 0 };
    case 'select':
      return { ...empty, text: value.value };
    case 'multi-select':
      return { ...empty, json: JSON.stringify(value.value) };
    case 'date':
      return { ...empty, text: value.value };
    case 'datetime':
      return {
        ...empty,
        int: value.value.ms,
        text: localDateOf(value.value.ms, value.value.zone),
        json: JSON.stringify({ zone: value.value.zone }),
      };
  }
}

/** Replace one page's values, membership and order keys. */
export function writeRowProjection(db: DatabaseSync, page: Page): void {
  db.prepare('delete from property_value where page_id = ?').run(page.id);
  db.prepare('delete from property_value_item where page_id = ?').run(page.id);
  db.prepare('delete from row_order where page_id = ?').run(page.id);

  const insertValue = db.prepare(
    `insert into property_value(page_id, property_id, kind, text_value, text_fold, num_value, int_value, json_value)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    'insert into property_value_item(page_id, property_id, option_id, position) values (?, ?, ?, ?)',
  );
  const insertOrder = db.prepare(
    'insert into row_order(view_id, page_id, order_key) values (?, ?, ?)',
  );

  for (const [propertyId, value] of Object.entries(page.properties ?? {})) {
    const columns = columnsOf(value);
    insertValue.run(
      page.id,
      propertyId,
      value.type,
      columns.text,
      columns.fold,
      columns.num,
      columns.int,
      columns.json,
    );
    if (value.type === 'multi-select') {
      value.value.forEach((optionId, position) => {
        insertItem.run(page.id, propertyId, optionId, position);
      });
    }
  }
  for (const [viewId, key] of Object.entries(page.orderKeys ?? {})) {
    insertOrder.run(viewId, page.id, key);
  }
}

/** Remove value rows whose page is gone. */
export function collectOrphans(db: DatabaseSync): void {
  db.exec(`
    delete from property_value where page_id not in (select id from page);
    delete from property_value_item where page_id not in (select id from page);
    delete from row_order where page_id not in (select id from page);
    delete from property_def where database_id not in (select id from page);
    delete from property_option where database_id not in (select id from page);
    delete from view_def where database_id not in (select id from page);
  `);
}

export function readContents(db: DatabaseSync): ProjectionContents {
  return {
    pages: db
      .prepare(
        `select id, title, body, parent_id as parentId, created_at as createdAt,
                is_database as isDatabase, row_json as rowJson
           from page order by id`,
      )
      .all() as ProjectionContents['pages'],
    propertyDefs: db
      .prepare(
        `select database_id as databaseId, property_id as propertyId, position, def_json as defJson
           from property_def order by database_id, property_id`,
      )
      .all() as ProjectionContents['propertyDefs'],
    propertyOptions: db
      .prepare(
        `select database_id as databaseId, property_id as propertyId, option_id as optionId, name, position
           from property_option order by database_id, property_id, option_id`,
      )
      .all() as ProjectionContents['propertyOptions'],
    views: db
      .prepare(
        `select database_id as databaseId, view_id as viewId, position, view_json as viewJson
           from view_def order by database_id, view_id`,
      )
      .all() as ProjectionContents['views'],
    propertyValues: db
      .prepare(
        `select page_id as pageId, property_id as propertyId, kind, text_value as textValue,
                text_fold as textFold, num_value as numValue, int_value as intValue, json_value as jsonValue
           from property_value order by page_id, property_id`,
      )
      .all() as ProjectionContents['propertyValues'],
    items: db
      .prepare(
        `select page_id as pageId, property_id as propertyId, option_id as optionId, position
           from property_value_item order by page_id, property_id, option_id`,
      )
      .all() as ProjectionContents['items'],
    rowOrder: db
      .prepare(
        `select view_id as viewId, page_id as pageId, order_key as orderKey
           from row_order order by view_id, page_id`,
      )
      .all() as ProjectionContents['rowOrder'],
  };
}
