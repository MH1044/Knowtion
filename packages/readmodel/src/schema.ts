/**
 * The derived read model's schema.
 *
 * Everything here is rebuildable from the operation log. None of it is ever synced:
 * a SQLite file copied by a cloud client mid-transaction is reliably corrupt, and the
 * index bytes are not even deterministic across machines because they depend on the
 * tokenizer and ICU version. See ADR-0004.
 */

/** Bumped when the table shapes change. A mismatch drops and rebuilds. */
export const SCHEMA_VERSION = 1;

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

create table if not exists page (
  rowid      integer primary key,
  id         text not null unique,
  uuid       text not null,
  parent_id  text,
  title      text not null,
  body       text not null default '',
  archived_at integer,
  updated_at integer not null
) strict;

create index if not exists page_parent on page(parent_id);
create index if not exists page_updated on page(updated_at desc);

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
