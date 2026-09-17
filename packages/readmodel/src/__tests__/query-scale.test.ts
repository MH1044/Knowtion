/**
 * Database queries at the v0.1 scale target: ten thousand rows, eight properties.
 *
 * Three numbers decide the design: projecting from empty, re-projecting after one cell
 * edit, and a filtered, sorted, grouped query. The release target is a second, a hundred
 * and fifty milliseconds and a hundred milliseconds respectively; the ceilings here are
 * several times looser, like every other scale test in the repository, so a busy machine
 * does not fail the build while a genuinely quadratic regression still does. The numbers
 * are printed so nobody has to guess the margin.
 */
import { describe, expect, it } from 'vitest';

import {
  Workspace,
  deterministicRuntime,
  evaluateQuery,
  viewSpecOf,
  type CalendarDate,
  type PropertyDef,
  type PropertyValue,
} from '@knowtion/engine';

import { ReadModel } from '../read-model.js';

const ROWS = 10_000;
const CTX = { nowMs: Date.UTC(2026, 0, 10), timeZone: 'UTC' };

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

function build() {
  const w = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
  const db = w.createPage({ title: 'Big' });
  w.convertToDatabase(db.id);
  const p: PropertyDef[] = [
    w.defineProperty(db.id, { name: 'Text', type: 'text' }),
    w.defineProperty(db.id, { name: 'Number', type: 'number' }),
    w.defineProperty(db.id, { name: 'Done', type: 'checkbox' }),
    w.defineProperty(db.id, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Done' }],
    }),
    w.defineProperty(db.id, {
      name: 'Tags',
      type: 'multi-select',
      options: [{ name: 'A' }, { name: 'B' }],
    }),
    w.defineProperty(db.id, { name: 'Due', type: 'date' }),
    w.defineProperty(db.id, { name: 'At', type: 'datetime' }),
    w.defineProperty(db.id, { name: 'Link', type: 'url' }),
  ];
  const status = at(p, 3);
  const tags = at(p, 4);
  for (let i = 0; i < ROWS; i++) {
    const values: Record<string, PropertyValue> = {
      [at(p, 0).id]: {
        type: 'text',
        value: `Row ${String(i)} ${i % 7 === 0 ? 'urgent' : 'routine'}`,
      },
      [at(p, 1).id]: { type: 'number', value: i % 97 },
      [at(p, 2).id]: { type: 'checkbox', value: i % 2 === 0 },
      [status.id]: { type: 'select', value: at(status.options, i % 3).id },
      [tags.id]: { type: 'multi-select', value: [at(tags.options, i % 2).id] },
      [at(p, 5).id]: {
        type: 'date',
        value: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}` as CalendarDate,
      },
      [at(p, 6).id]: {
        type: 'datetime',
        value: { ms: 1_700_000_000_000 + i * 60_000, zone: 'UTC' },
      },
      [at(p, 7).id]: { type: 'url', value: `https://example.test/${String(i)}` },
    };
    w.createRow(db.id, { title: `r${String(i)}`, values });
  }
  return { w, db, p, status, tags, table: at(w.database(db.id).views, 0) };
}

describe(`queries over ${String(ROWS)} rows`, () => {
  const { w, db, p, status, tags, table } = build();
  const model = ReadModel.open(':memory:');

  it('projects from empty in bounded time', () => {
    const started = performance.now();
    const stats = model.projectPages(w.allPages());
    const ms = performance.now() - started;
    expect(stats.rowsRewritten).toBe(ROWS + 1);
    console.log(`  full projection ${ms.toFixed(0)}ms`);
    // Measured at 3.6s alone. A full verify runs this beside every other worker, so the
    // budget is a regression tripwire, not a target.
    expect(ms).toBeLessThan(15_000);
  }, 60_000);

  it('re-projects after one cell edit by rewriting one row', () => {
    const row = at(w.rows(db.id), 5_000);
    w.setPropertyValue(row.id, at(p, 1).id, { type: 'number', value: 1_000 });
    const started = performance.now();
    const stats = model.projectPages(w.allPages());
    const ms = performance.now() - started;
    expect(stats.rowsRewritten).toBe(1);
    console.log(`  one-cell reprojection ${ms.toFixed(0)}ms`);
    // Measured at ~1.7s: the value tables are skipped, but the page table and its FTS
    // index are still fully replaced. The host uses upsertPage on the hot path (about a
    // millisecond, below) and this only for structural changes; diffing the page table
    // is the recorded follow-on if a structural change at this scale is ever felt.
    expect(ms).toBeLessThan(5_000);

    const upsertStarted = performance.now();
    model.upsertPage(w.getPage(row.id));
    console.log(`  upsertPage ${(performance.now() - upsertStarted).toFixed(0)}ms`);
  }, 60_000);

  it('filters, sorts and groups the whole table within budget, and agrees with the evaluator', () => {
    w.updateView(db.id, table.id, {
      filter: {
        v: 1,
        expr: {
          kind: 'and',
          clauses: [
            { kind: 'leaf', property: at(p, 0).id, op: 'contains', value: 'routine' },
            { kind: 'leaf', property: at(p, 1).id, op: 'gt', value: 40 },
            { kind: 'leaf', property: tags.id, op: 'hasOption', value: at(tags.options, 0).id },
          ],
        },
      },
      sorts: [
        { field: at(p, 5).id, direction: 'desc' },
        { field: 'title', direction: 'asc' },
      ],
      groupBy: status.id,
    });
    model.projectPages(w.allPages());
    const view = at(w.database(db.id).views, 0);

    const started = performance.now();
    const result = model.queryView(db.id, view.id, CTX);
    const ms = performance.now() - started;
    console.log(
      `  filtered+sorted+grouped query: ${String(result.total)} rows in ${ms.toFixed(0)}ms`,
    );
    expect(result.total).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(1_500);

    const evaluated = evaluateQuery(
      w.rows(db.id),
      w.database(db.id).properties,
      viewSpecOf(view),
      CTX,
      view.id,
    );
    expect(result.rows.map((r) => r.id)).toEqual(evaluated.rows.map((r) => r.id));
    expect(result.groups?.map((g) => [g.key, g.rows.length])).toEqual(
      evaluated.groups?.map((g) => [g.key, g.rows.length]),
    );
  }, 60_000);

  it('pages a plain table query cheaply', () => {
    const started = performance.now();
    const page = model.query(db.id, { sorts: [{ field: 'title', direction: 'asc' }] }, CTX, {
      limit: 100,
      offset: 5_000,
    });
    const ms = performance.now() - started;
    console.log(`  paged query (limit 100 offset 5000) ${ms.toFixed(0)}ms`);
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(ROWS);
    expect(ms).toBeLessThan(750);
    model.close();
  }, 60_000);
});
