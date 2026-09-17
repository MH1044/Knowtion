/**
 * The derived read model's schema.
 *
 * Everything here is rebuildable from the operation log. None of it is ever synced:
 * a SQLite file copied by a cloud client mid-transaction is reliably corrupt, and the
 * index bytes are not even deterministic across machines because they depend on the
 * tokenizer and ICU version. See ADR-0004.
 *
 * Version 2 adds databases: property definitions, options, views, one row per (page,
 * property) value, a junction table for multi-select, and per-view manual order. The
 * shapes follow the twin-interpreter contract in the engine's query module — every
 * comparison SQL makes must give the answer the JavaScript evaluator gives — so the
 * columns hold the OUTPUTS of the engine's shared functions (folded text, the calendar
 * date of an instant in its zone) rather than re-deriving them in SQL.
 */

/** Bumped when the table shapes change. A mismatch drops and rebuilds. */
export const SCHEMA_VERSION = 2;

/**
 * Bumped when the way text is turned into tokens changes.
 *
 * Kept separate from SCHEMA_VERSION because the tables can be right while the index is
 * built by different rules — a segmentation change, or a SQLite upgrade that alters the
 * tokenizer. Without it, a client would silently serve results built under the old
 * rules and nobody would know why searches stopped matching.
 */
export const INDEX_VERSION = 1;

export const DDL = `
create table if not exists meta (
  key   text primary key,
  value text not null
) strict;

-- One row per live page. Fully replaced on every projection of the hierarchy, so rowid
-- is NOT stable across projections; nothing outside this file may hold one.
create table if not exists page (
  rowid       integer primary key,
  id          text not null unique,
  uuid        text not null,
  parent_id   text,
  title       text not null,
  body        text not null default '',
  archived_at integer,
  created_at  integer not null,
  updated_at  integer not null,
  -- 1 when the page carries a database schema.
  is_database integer not null default 0,
  -- A canonical fingerprint of the page's property values and order keys. When it has
  -- not changed, the value tables below are not rewritten; and it is what a query reads
  -- a row's values from, so no second statement is needed per row.
  row_json    text not null default '{"p":{},"o":{}}'
) strict;

create index if not exists page_parent on page(parent_id);
create index if not exists page_updated on page(updated_at desc);

-- Database definitions. Small (databases x properties) and fully replaced each time.
create table if not exists property_def (
  database_id text not null,
  property_id text not null,
  name        text not null,
  type        text not null,
  position    integer not null,
  def_json    text not null,
  primary key (database_id, property_id)
) strict;

create table if not exists property_option (
  database_id text not null,
  property_id text not null,
  option_id   text not null,
  name        text not null,
  position    integer not null,
  primary key (database_id, property_id, option_id)
) strict;

create table if not exists view_def (
  database_id text not null,
  view_id     text not null,
  name        text not null,
  type        text not null,
  position    integer not null,
  view_json   text not null,
  primary key (database_id, view_id)
) strict;

-- One row per (page, property) that holds a value the parent's schema accepts. Exactly
-- one typed column carries the value, chosen by its kind:
--   text, url      text_value = raw, text_fold = folded (what equality and containment use)
--   number         num_value
--   checkbox       int_value 0 or 1
--   select         text_value = option id
--   date           text_value = YYYY-MM-DD
--   datetime       int_value = instant ms, text_value = the calendar date in the value's zone
--   multi-select   json_value = the option id array; membership lives in property_value_item
create table if not exists property_value (
  page_id     text not null,
  property_id text not null,
  kind        text not null,
  text_value  text,
  text_fold   text,
  num_value   real,
  int_value   integer,
  json_value  text,
  primary key (page_id, property_id)
) strict;

create index if not exists pv_fold on property_value(property_id, text_fold);
create index if not exists pv_text on property_value(property_id, text_value);
create index if not exists pv_num  on property_value(property_id, num_value);
create index if not exists pv_int  on property_value(property_id, int_value);

-- Multi-select membership, so "has option" is an index range rather than a JSON scan.
create table if not exists property_value_item (
  page_id     text not null,
  property_id text not null,
  option_id   text not null,
  position    integer not null,
  primary key (page_id, property_id, option_id)
) strict;

create index if not exists pvi_option on property_value_item(property_id, option_id, page_id);

-- Manual order, keyed on (view, row) per FORMAT.md section 10. Keys are ASCII and
-- compared with BINARY collation, which is what the engine's compareOrderKeys does.
create table if not exists row_order (
  view_id   text not null,
  page_id   text not null,
  order_key text not null,
  primary key (view_id, page_id)
) strict;

create index if not exists row_order_key on row_order(view_id, order_key);

-- Holds SEGMENTED text, which is what the index must see. Kept separate from page so
-- the display text is never altered by indexing concerns. See segmenter.ts.
create table if not exists search_doc (
  rowid integer primary key,
  title text not null,
  body  text not null
) strict;

-- External content rather than contentless: a contentless table returns NULL for every
-- column, which kills snippet() and highlight() and leaves nothing to show in results.
create virtual table if not exists search using fts5(
  title,
  body,
  content='search_doc',
  content_rowid='rowid',
  prefix='2 3'
);

-- Triggers keep the index consistent inside the same transaction as the write. Doing it
-- in application code instead is how an index drifts from its content table.
create trigger if not exists search_doc_ai after insert on search_doc begin
  insert into search(rowid, title, body) values (new.rowid, new.title, new.body);
end;

create trigger if not exists search_doc_ad after delete on search_doc begin
  insert into search(search, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
end;

create trigger if not exists search_doc_au after update on search_doc begin
  insert into search(search, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
  insert into search(rowid, title, body) values (new.rowid, new.title, new.body);
end;
`;

/**
 * Everything DDL creates, in an order that can be dropped.
 *
 * Kept beside the DDL rather than in read-model.ts so a table added above and forgotten
 * here fails one test (the one that asserts dropping leaves sqlite_master empty) instead
 * of leaving a stale table behind on the next version bump.
 */
export const DROP_DDL = `
drop trigger if exists search_doc_ai;
drop trigger if exists search_doc_ad;
drop trigger if exists search_doc_au;
drop table if exists search;
drop table if exists search_doc;
drop table if exists row_order;
drop table if exists property_value_item;
drop table if exists property_value;
drop table if exists view_def;
drop table if exists property_option;
drop table if exists property_def;
drop table if exists page;
drop table if exists meta;
`;
