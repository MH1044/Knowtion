/**
 * The SQL interpreter, run over the same semantic table as the JavaScript one.
 *
 * `@knowtion/engine/query-cases` holds rows and expected orders that the engine's
 * evaluator test asserts. Here the same rows are projected into SQLite and the same specs
 * run through the compiler. A case that one side can pass and the other cannot is a rule
 * that exists in one interpreter only — the drift this file exists to catch.
 */
import { describe, expect, it } from 'vitest';

import type { NodeId, Page, Uuid } from '@knowtion/engine';
import {
  CASE_DEFS,
  CASE_ROWS,
  CASE_VIEW,
  QUERY_CASES,
  type CaseRow,
} from '@knowtion/engine/query-cases';

import { ReadModel } from '../read-model.js';

const DATABASE_ID = '1@1' as NodeId;
const DEFAULT_CTX = { nowMs: Date.UTC(2026, 0, 10, 23, 30), timeZone: 'UTC' };

/** The case rows as Pages under one database page, as the engine would decode them. */
function pagesOf(): Page[] {
  const database: Page = {
    id: DATABASE_ID,
    parentId: undefined,
    uuid: 'a0000000-0000-7000-8000-000000000000' as Uuid,
    title: 'Cases',
    createdAt: 0,
    updatedAt: 0,
    database: {
      createdAt: 0,
      properties: CASE_DEFS,
      views: [
        {
          id: CASE_VIEW,
          name: 'Table',
          type: 'table',
          sorts: [],
          columns: CASE_DEFS.map((d) => d.id),
          hidden: [],
          createdAt: 0,
        },
      ],
    },
  };
  const rows = CASE_ROWS.map((row: CaseRow): Page => ({
    id: row.id as NodeId,
    parentId: DATABASE_ID,
    uuid: `b0000000-0000-7000-8000-00000000000${row.id.slice(1)}` as Uuid,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    properties: row.properties ?? {},
    orderKeys: (row.orderKeys ?? {}) as Page['orderKeys'] & object,
  }));
  return [database, ...rows];
}

function model(): ReadModel {
  const m = ReadModel.open(':memory:');
  m.projectPages(pagesOf());
  return m;
}

describe('the semantic table, through SQL', () => {
  const m = model();

  it.each(QUERY_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = m.query(
      DATABASE_ID,
      c.spec,
      c.ctx ?? DEFAULT_CTX,
      {},
      c.inView === true ? CASE_VIEW : undefined,
    );
    expect(result.rows.map((r) => r.id)).toEqual(c.expected);
    expect(result.total).toBe(c.expected.length);
    expect(result.warnings.map((w) => w.code)).toEqual(c.expectedWarnings ?? []);
    if (c.expectedGroups !== undefined) {
      expect(result.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual(c.expectedGroups);
    } else {
      expect(result.groups).toBeUndefined();
    }
  });
});

describe('the read API', () => {
  it("returns a row's values without opening any document, and its order key in the view", () => {
    const m = model();
    const result = m.query(DATABASE_ID, { sorts: [] }, DEFAULT_CTX, {}, CASE_VIEW);
    const r6 = result.rows.find((r) => r.id === 'r6');
    expect(r6?.orderKey).toBe('a0');
    expect(r6?.values).toEqual(CASE_ROWS[5]?.properties);
    const r2 = result.rows.find((r) => r.id === 'r2');
    expect(r2?.orderKey).toBeUndefined();
    m.close();
  });

  it('pages with limit and offset, and reports the total regardless', () => {
    const m = model();
    const page = m.query(DATABASE_ID, { sorts: [] }, DEFAULT_CTX, { limit: 2, offset: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(['r3', 'r4']);
    expect(page.total).toBe(6);
    m.close();
  });

  it('leaves archived rows out unless asked', () => {
    const m = ReadModel.open(':memory:');
    const pages = pagesOf();
    const r3 = pages.find((p) => p.id === ('r3' as NodeId));
    if (r3 !== undefined) r3.archivedAt = 5;
    m.projectPages(pages);
    expect(m.query(DATABASE_ID, { sorts: [] }, DEFAULT_CTX).rows.map((r) => r.id)).not.toContain(
      'r3',
    );
    expect(
      m
        .query(DATABASE_ID, { sorts: [] }, DEFAULT_CTX, { includeArchived: true })
        .rows.map((r) => r.id),
    ).toContain('r3');
    m.close();
  });

  it('runs a stored view by id, and reads the schema back', () => {
    const m = model();
    const schema = m.databaseSchema(DATABASE_ID);
    expect(schema?.properties).toEqual(CASE_DEFS);
    expect(schema?.views.map((v) => v.id)).toEqual([CASE_VIEW]);
    expect(m.queryView(DATABASE_ID, CASE_VIEW, DEFAULT_CTX).rows.map((r) => r.id)).toEqual([
      'r6',
      'r1',
      'r3',
      'r2',
      'r4',
      'r5',
    ]);
    expect(m.databaseSchema('r1')).toBeUndefined();
    expect(() => m.query('r1', { sorts: [] }, DEFAULT_CTX)).toThrow(/not a database/);
    expect(() => m.queryView(DATABASE_ID, 'nope', DEFAULT_CTX)).toThrow(/no view/);
    m.close();
  });
});
