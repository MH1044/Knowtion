/**
 * Generate the golden database fixture for the CURRENT data layout (ADR-0014).
 *
 * Run once per released layout, then never again for that layout: the fixture is frozen
 * bytes produced by the build of the day, and CI asserts every future build still reads
 * them to the same pages, values, order and query answers. It is the only mechanism that
 * catches an accidental change to how a value, a schema or an order key is written into
 * the log before it reaches a user's folder — where, with no backend, it could never be
 * corrected.
 *
 *   npm run build && node packages/engine/scripts/make-fixtures.mjs
 *
 * Regenerating an EXISTING fixture is almost always a mistake. If the test no longer
 * matches, the layout changed; fix the layout or cut a new fixture directory.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUERY_SPEC_VERSION,
  Workspace,
  deterministicRuntime,
  evaluateQuery,
  viewSpecOf,
} from '../dist/index.js';

/** Never overwrite a fixture that already exists. See the header. */
function freeze(path, bytes) {
  if (existsSync(path)) {
    console.log(`kept    ${path} (already frozen)`);
    return false;
  }
  writeFileSync(path, bytes);
  console.log(`wrote   ${path}`);
  return true;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'fixtures', 'v0');
mkdirSync(outDir, { recursive: true });

/** Fixed clock and seed: the same bytes on every machine, forever. */
const workspace = Workspace.create({ runtime: deterministicRuntime(42), peerId: 1n });

// A plain page with a child, so the fixture is not only a database.
const notes = workspace.createPage({ title: 'Notes' });
workspace.createPage({ parentId: notes.id, title: 'Scratch' });

// One database with every property type.
const db = workspace.createPage({ title: 'Projects' });
workspace.convertToDatabase(db.id);
const text = workspace.defineProperty(db.id, { name: 'Summary', type: 'text' });
const number = workspace.defineProperty(db.id, { name: 'Estimate', type: 'number' });
const checkbox = workspace.defineProperty(db.id, { name: 'Shipped', type: 'checkbox' });
const status = workspace.defineProperty(db.id, {
  name: 'Status',
  type: 'select',
  options: [{ name: 'Todo' }, { name: 'Doing', color: 'blue' }, { name: 'Done', color: 'green' }],
});
const tags = workspace.defineProperty(db.id, {
  name: 'Tags',
  type: 'multi-select',
  options: [{ name: 'infra' }, { name: 'ui' }],
});
const due = workspace.defineProperty(db.id, { name: 'Due', type: 'date' });
const reviewed = workspace.defineProperty(db.id, { name: 'Reviewed', type: 'datetime' });
const link = workspace.defineProperty(db.id, { name: 'Link', type: 'url' });

const [todo, doing, done] = status.options.map((o) => o.id);
const [infra, ui] = tags.options.map((o) => o.id);

const rows = [
  workspace.createRow(db.id, {
    title: 'Crash gate',
    values: {
      [text.id]: { type: 'text', value: 'Torn writes and recovery' },
      [number.id]: { type: 'number', value: 3.5 },
      [checkbox.id]: { type: 'checkbox', value: true },
      [status.id]: { type: 'select', value: done },
      [tags.id]: { type: 'multi-select', value: [infra] },
      [due.id]: { type: 'date', value: '2026-09-10' },
      [reviewed.id]: { type: 'datetime', value: { ms: 1_757_500_000_000, zone: 'Europe/London' } },
      [link.id]: { type: 'url', value: 'https://example.test/gate' },
    },
  }),
  workspace.createRow(db.id, {
    title: 'Table view',
    values: {
      [text.id]: { type: 'text', value: 'Typed cells, schema editor' },
      [number.id]: { type: 'number', value: -2 },
      [status.id]: { type: 'select', value: doing },
      [tags.id]: { type: 'multi-select', value: [ui, infra] },
      [due.id]: { type: 'date', value: '2026-09-17' },
    },
  }),
  workspace.createRow(db.id, {
    title: 'Board view',
    values: {
      [status.id]: { type: 'select', value: todo },
      [tags.id]: { type: 'multi-select', value: [] },
      [checkbox.id]: { type: 'checkbox', value: false },
    },
  }),
  // A row with nothing set at all: absent values, not empty ones.
  workspace.createRow(db.id, { title: 'Importer' }),
];

// Views: the default table with a filter, sorts and a manual order; a board by status.
const table = workspace.database(db.id).views[0];
workspace.updateView(db.id, table.id, {
  name: 'Open work',
  filter: {
    v: QUERY_SPEC_VERSION,
    expr: {
      kind: 'and',
      clauses: [
        { kind: 'leaf', property: status.id, op: 'optionIsNot', value: done },
        {
          kind: 'or',
          clauses: [
            { kind: 'leaf', property: due.id, op: 'isEmpty' },
            {
              kind: 'leaf',
              property: due.id,
              op: 'onOrAfter',
              value: { kind: 'relative', days: -30 },
            },
          ],
        },
      ],
    },
  },
  sorts: [
    { field: number.id, direction: 'desc' },
    { field: 'title', direction: 'asc' },
  ],
  hidden: [link.id],
});
const board = workspace.createView(db.id, { name: 'By status', type: 'board', groupBy: status.id });
workspace.setRowOrder(rows[3].id, board.id, { kind: 'first' });
workspace.setRowOrder(rows[1].id, board.id, { kind: 'after', row: rows[3].id });
workspace.setRowOrder(rows[0].id, board.id, { kind: 'last' });

// An archived row stays in the log and out of every query.
const archived = workspace.createRow(db.id, { title: 'Abandoned idea' });
workspace.archivePage(archived.id);

// Every relative date resolves against the same instant.
const ctx = { nowMs: 1_758_000_000_000, timeZone: 'UTC' };
const schema = workspace.database(db.id);
const liveRows = workspace.rows(db.id);
const queries = Object.fromEntries(
  schema.views.map((view) => {
    const result = evaluateQuery(liveRows, schema.properties, viewSpecOf(view), ctx, view.id);
    return [
      view.id,
      {
        rows: result.rows.map((r) => r.title),
        groups: result.groups?.map((g) => [g.key, g.rows.map((r) => r.title)]),
        warnings: result.warnings,
      },
    ];
  }),
);

const expected = {
  ctx,
  pages: workspace.allPages(),
  trash: workspace.trash().map((p) => p.title),
  tree: workspace.tree({ collapseDatabases: true }),
  boardOrder: workspace.rows(db.id, { viewId: board.id }).map((r) => r.title),
  queries,
};

const snapshot = workspace.snapshot();
const wrote = freeze(join(outDir, 'database.loro'), snapshot);
if (wrote || !existsSync(join(outDir, 'database.expected.json'))) {
  freeze(join(outDir, 'database.expected.json'), JSON.stringify(expected, null, 2) + '\n');
}
console.log(`snapshot ${String(snapshot.length)} bytes, ${String(expected.pages.length)} pages`);
