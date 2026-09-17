/**
 * The schema and the rebuild path.
 *
 * Before this file, nothing proved the version-mismatch rebuild actually ran: the only
 * test opened a fresh in-memory store and observed it was empty, which a broken rebuild
 * would also satisfy. These write a real file under an older schema, reopen it, and
 * look. The drop-list test is what keeps that list honest: a table added to the DDL and
 * forgotten there would survive a version bump as stale furniture.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { Workspace, deterministicRuntime } from '@knowtion/engine';

import { ReadModel } from '../read-model.js';
import { DDL, DROP_DDL, INDEX_VERSION, SCHEMA_VERSION } from '../schema.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    // Windows holds a lock on a SQLite file briefly after close.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function fileStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowtion-readmodel-'));
  dirs.push(dir);
  return join(dir, 'index.db');
}

/** The v1 shape of the store, as a v0.2 install would have left it on disk. */
const V1_DDL = `
create table meta (key text primary key, value text not null) strict;
create table page (
  rowid integer primary key, id text not null unique, uuid text not null, parent_id text,
  title text not null, body text not null default '', archived_at integer, updated_at integer not null
) strict;
`;

function metaOf(path: string): Record<string, string> {
  const raw = new DatabaseSync(path);
  try {
    const rows = raw.prepare('select key, value from meta').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    raw.close();
  }
}

function objectNames(db: DatabaseSync): string[] {
  return (
    db.prepare("select name from sqlite_master where name not like 'sqlite_%'").all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .sort();
}

describe('the drop list', () => {
  it('removes everything the DDL creates, so a version bump leaves nothing stale', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    expect(objectNames(db).length).toBeGreaterThan(10);
    db.exec(DROP_DDL);
    expect(objectNames(db)).toEqual([]);
    db.close();
  });

  it('every table is strict, so a mistyped value is refused rather than stored', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    expect(() =>
      db
        .prepare(
          'insert into property_value(page_id, property_id, kind, num_value) values (?, ?, ?, ?)',
        )
        .run('p', 'q', 'number', 'not a number'),
    ).toThrow(/cannot store TEXT value in REAL column/);
    expect(() =>
      db
        .prepare(
          'insert into property_value(page_id, property_id, kind, int_value) values (?, ?, ?, ?)',
        )
        .run('p', 'q', 'checkbox', 'yes'),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
    // STRICT does convert a number INTO a text column, so order keys rely on the engine
    // never producing one, not on the database refusing it.
    db.close();
  });
});

describe('opening a store built by different rules', () => {
  it('rebuilds a file written under an older schema version', async () => {
    const path = await fileStore();
    const raw = new DatabaseSync(path);
    raw.exec(V1_DDL);
    raw.prepare('insert into meta values (?, ?)').run('schema_version', String(SCHEMA_VERSION - 1));
    raw.prepare('insert into meta values (?, ?)').run('index_version', String(INDEX_VERSION));
    raw
      .prepare('insert into page(id, uuid, parent_id, title, updated_at) values (?, ?, ?, ?, ?)')
      .run('1@1', 'u', null, 'Stale', 1);
    raw.close();

    const model = ReadModel.open(path);
    expect(model.isEmpty).toBe(true); // the stale row did not survive
    expect(model.pages()).toEqual([]);
    model.close();
    expect(metaOf(path)).toEqual({
      schema_version: String(SCHEMA_VERSION),
      index_version: String(INDEX_VERSION),
    });
  });

  it('rebuilds a file whose index was built under different tokenizer rules', async () => {
    const path = await fileStore();
    const first = ReadModel.open(path);
    const workspace = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
    workspace.createPage({ title: 'Indexed under the old rules' });
    first.projectPages(workspace.allPages());
    first.close();

    const raw = new DatabaseSync(path);
    raw
      .prepare('update meta set value = ? where key = ?')
      .run(String(INDEX_VERSION + 1), 'index_version');
    raw.close();

    const model = ReadModel.open(path);
    expect(model.isEmpty).toBe(true);
    model.close();
    expect(metaOf(path).index_version).toBe(String(INDEX_VERSION));
  });

  it('keeps a store built under the current rules, so a normal launch is not a rebuild', async () => {
    // Nothing asserted this before: a rebuild on every launch would have passed every
    // other test while throwing away the index each time the app started.
    const path = await fileStore();
    const first = ReadModel.open(path);
    const workspace = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
    workspace.createPage({ title: 'Kept' });
    first.projectPages(workspace.allPages());
    first.close();

    const second = ReadModel.open(path);
    expect(second.isEmpty).toBe(false);
    expect(second.pages().map((p) => p.title)).toEqual(['Kept']);
    second.close();
  });

  it('rebuilds a file with no meta table at all', async () => {
    const path = await fileStore();
    const raw = new DatabaseSync(path);
    raw.exec('create table unrelated (x integer)');
    raw.close();
    const model = ReadModel.open(path);
    expect(model.isEmpty).toBe(true);
    model.close();
    expect(metaOf(path).schema_version).toBe(String(SCHEMA_VERSION));
  });
});
