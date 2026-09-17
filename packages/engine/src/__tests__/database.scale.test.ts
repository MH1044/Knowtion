/**
 * A database at the v0.1 scale target: ten thousand rows, eight properties each.
 *
 * ADR-0014 measured where the cost lands — not in importing the document but in decoding
 * node data on read. These ceilings are loose on purpose, like workspace.scale.test.ts:
 * they catch an algorithm that degrades catastrophically (decoding the schema once per
 * row instead of once per read, say), not milliseconds on whatever machine CI runs on.
 * The snapshot size is printed rather than asserted: it is an input to the compaction
 * policy, worth knowing and not worth failing a build over.
 */
import { describe, expect, it } from 'vitest';

import type { CalendarDate, PropertyDef, PropertyValue } from '../properties.js';
import { deterministicRuntime } from '../runtime.js';
import { Workspace } from '../workspace.js';

const ROWS = 10_000;

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
  const started = performance.now();
  for (let i = 0; i < ROWS; i++) {
    const values: Record<string, PropertyValue> = {
      [at(p, 0).id]: { type: 'text', value: `Row ${String(i)}` },
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
  return { w, db, table: at(w.database(db.id).views, 0), buildMs: performance.now() - started };
}

describe(`a database of ${String(ROWS)} rows`, () => {
  const { w, db, table, buildMs } = build();

  it('reads every page, values included, in bounded time', () => {
    const started = performance.now();
    const pages = w.allPages();
    const ms = performance.now() - started;
    expect(pages).toHaveLength(ROWS + 1);
    const withValues = pages.filter((page) => Object.keys(page.properties ?? {}).length === 8);
    expect(withValues).toHaveLength(ROWS);
    console.log(`  built in ${buildMs.toFixed(0)}ms; allPages() ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(5_000);
  }, 60_000);

  it('lists the rows in a view without decoding the schema per row', () => {
    const started = performance.now();
    const rows = w.rows(db.id, { viewId: table.id });
    const ms = performance.now() - started;
    expect(rows).toHaveLength(ROWS);
    console.log(`  rows(view) ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(2_000);
  }, 60_000);

  it('a collapsed tree leaves the rows out and counts them', () => {
    const started = performance.now();
    const tree = w.tree({ collapseDatabases: true });
    const ms = performance.now() - started;
    expect(at(tree, 0).children).toEqual([]);
    expect(at(tree, 0).rowCount).toBe(ROWS);
    console.log(`  tree(collapsed) ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(2_000);
  }, 60_000);

  it('reopens from a snapshot in bounded time, and reports its size', () => {
    const snapshot = w.snapshot();
    const started = performance.now();
    const reopened = Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n });
    const rows = reopened.rows(db.id);
    const ms = performance.now() - started;
    expect(rows).toHaveLength(ROWS);
    console.log(
      `  snapshot ${(snapshot.length / 1024).toFixed(0)} KiB; reopen + rows ${ms.toFixed(0)}ms`,
    );
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});
