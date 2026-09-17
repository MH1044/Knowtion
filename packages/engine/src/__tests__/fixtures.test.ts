/**
 * Golden-file compatibility test for the database layout (ADR-0014).
 *
 * `fixtures/v0/database.loro` is a Loro snapshot written by the build that shipped the
 * layout: one database with every property type, options, rows with and without values,
 * a filtered and sorted table view with a hidden column, a board with a manual order,
 * and an archived row. `database.expected.json` is what that build read back from it.
 * Every future build must read the same pages, the same values, the same order, and
 * answer the same queries. This is the only mechanism that catches an accidental change
 * to how a value or a key is written before it reaches a user's folder — where, with no
 * backend, it could never be corrected.
 *
 * If this fails, the layout changed. Do not regenerate the fixture. Either revert the
 * change or cut a new fixture directory for a new layout version.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32c } from '@knowtion/format';
import { describe, expect, it } from 'vitest';

import {
  Workspace,
  deterministicRuntime,
  evaluateQuery,
  viewSpecOf,
  type Page,
  type PageNode,
  type QueryContext,
  type QueryProblem,
} from '../index.js';

const fixturesV0 = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'v0');

/** Byte-exact identity of the snapshot. Changing a number here defeats the test. */
const SNAPSHOT = { size: 6275, crc: 0x8792b372 };

interface Expected {
  ctx: QueryContext;
  pages: Page[];
  trash: string[];
  tree: PageNode[];
  boardOrder: string[];
  queries: Record<
    string,
    { rows: string[]; groups?: [string | null, string[]][]; warnings: QueryProblem[] }
  >;
}

const snapshot = new Uint8Array(readFileSync(join(fixturesV0, 'database.loro')));
const expected = JSON.parse(
  readFileSync(join(fixturesV0, 'database.expected.json'), 'utf8'),
) as Expected;

/** Through JSON, so `undefined` fields and class instances compare the way the file does. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function open(): Workspace {
  // A different seed and peer than the writer used: reading must not depend on either.
  return Workspace.open(snapshot, { runtime: deterministicRuntime(7), peerId: 9n });
}

describe('database layout v0 golden fixture', () => {
  it('the fixture directory contains exactly the files we assert on', () => {
    expect(readdirSync(fixturesV0).sort()).toEqual(['database.expected.json', 'database.loro']);
  });

  it('is byte-identical to when it was frozen', () => {
    expect(snapshot.length).toBe(SNAPSHOT.size);
    expect(crc32c(snapshot)).toBe(SNAPSHOT.crc);
  });

  it('reads back every page, schema, value and order key as the writing build did', () => {
    const workspace = open();
    expect(plain(workspace.allPages())).toEqual(expected.pages);
    expect(workspace.trash().map((p) => p.title)).toEqual(expected.trash);
    expect(plain(workspace.tree({ collapseDatabases: true }))).toEqual(expected.tree);
  });

  it('covers every property type, so a change to any encoding is caught', () => {
    const database = expected.pages.find((p) => p.database !== undefined);
    const types = database?.database?.properties.map((p) => p.type).sort();
    expect(types).toEqual(
      ['checkbox', 'date', 'datetime', 'multi-select', 'number', 'select', 'text', 'url'].sort(),
    );
    const values = expected.pages.flatMap((p) => Object.values(p.properties ?? {}));
    expect(new Set(values.map((v) => v.type)).size).toBe(8);
  });

  it('keeps the manual order of the board', () => {
    const workspace = open();
    const database = workspace.allPages().find((p) => p.database !== undefined);
    const board = database?.database?.views.find((v) => v.type === 'board');
    expect(database).toBeDefined();
    expect(board).toBeDefined();
    if (database === undefined || board === undefined) return;
    expect(workspace.rows(database.id, { viewId: board.id }).map((r) => r.title)).toEqual(
      expected.boardOrder,
    );
  });

  it('answers every stored view the same way', () => {
    const workspace = open();
    const database = workspace.allPages().find((p) => p.database !== undefined);
    expect(database?.database).toBeDefined();
    if (database?.database === undefined) return;
    const rows = workspace.rows(database.id);
    expect(Object.keys(expected.queries).sort()).toEqual(
      database.database.views.map((v) => v.id).sort(),
    );
    for (const view of database.database.views) {
      const result = evaluateQuery(
        rows,
        database.database.properties,
        viewSpecOf(view),
        expected.ctx,
        view.id,
      );
      expect(
        plain({
          rows: result.rows.map((r) => r.title),
          groups: result.groups?.map((g) => [g.key, g.rows.map((r) => r.title)]),
          warnings: result.warnings,
        }),
      ).toEqual(expected.queries[view.id]);
    }
  });
});
