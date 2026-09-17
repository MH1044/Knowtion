/**
 * Projecting databases: incremental must equal rebuilt, on every table.
 *
 * The existing rebuild test compares `pages()`. That is blind to everything this commit
 * adds, so these compare `contents()` — every projected table — over a long random
 * session that defines and removes properties, sets and clears values, retypes, reorders
 * rows, edits views, archives and deletes; and they mix `upsertPage` into the incremental
 * side, since the host will use it on the hot path. The rows-rewritten count proves the
 * fingerprint skip actually skips.
 */
import { describe, expect, it } from 'vitest';

import {
  Workspace,
  deterministicRuntime,
  type CalendarDate,
  type NodeId,
  type PropertyDef,
  type PropertyValue,
} from '@knowtion/engine';

import { ReadModel } from '../read-model.js';

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

/** A deterministic PRNG so any failure replays from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function rebuilt(workspace: Workspace): ReadModel {
  const fresh = ReadModel.open(':memory:');
  fresh.projectPages(workspace.allPages());
  return fresh;
}

/** A random value that fits a property. */
function randomValue(rand: () => number, def: PropertyDef): PropertyValue | undefined {
  switch (def.type) {
    case 'text':
      return { type: 'text', value: `v${String(Math.floor(rand() * 20))}` };
    case 'url':
      return { type: 'url', value: `https://x.test/${String(Math.floor(rand() * 20))}` };
    case 'number':
      return { type: 'number', value: Math.floor(rand() * 100) - 50 };
    case 'checkbox':
      return { type: 'checkbox', value: rand() < 0.5 };
    case 'select': {
      const option = def.options[Math.floor(rand() * def.options.length)];
      return option === undefined ? undefined : { type: 'select', value: option.id };
    }
    case 'multi-select': {
      const chosen = def.options.filter(() => rand() < 0.5).map((o) => o.id);
      return chosen.length === 0 ? undefined : { type: 'multi-select', value: chosen };
    }
    case 'date':
      return {
        type: 'date',
        value:
          `2026-0${String(1 + Math.floor(rand() * 9))}-1${String(Math.floor(rand() * 9))}` as CalendarDate,
      };
    case 'datetime':
      return {
        type: 'datetime',
        value: {
          ms: 1_700_000_000_000 + Math.floor(rand() * 1e9),
          zone: rand() < 0.5 ? 'UTC' : 'Asia/Tokyo',
        },
      };
  }
}

describe('projecting a database', () => {
  it('a store maintained step by step matches one rebuilt from scratch, on every table', () => {
    const rand = rng(11);
    const workspace = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
    const incremental = ReadModel.open(':memory:');

    const db = workspace.createPage({ title: 'Tasks' });
    workspace.convertToDatabase(db.id);
    const types = [
      'text',
      'number',
      'checkbox',
      'select',
      'multi-select',
      'date',
      'datetime',
      'url',
    ] as const;
    for (const type of types) {
      workspace.defineProperty(db.id, {
        name: type,
        type,
        ...(type === 'select' || type === 'multi-select'
          ? { options: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] }
          : {}),
      });
    }
    const rows: NodeId[] = [];
    incremental.projectPages(workspace.allPages());

    for (let step = 0; step < 300; step++) {
      const schema = workspace.database(db.id);
      const choice = rand();
      let touched: NodeId | undefined;
      if (choice < 0.25 || rows.length === 0) {
        touched = workspace.createRow(db.id, { title: `row ${String(step)}` }).id;
        rows.push(touched);
      } else if (choice < 0.6) {
        const row = at(rows, Math.floor(rand() * rows.length));
        const def = at(schema.properties, Math.floor(rand() * schema.properties.length));
        const value = randomValue(rand, def);
        if (value === undefined || rand() < 0.15) workspace.clearPropertyValue(row, def.id);
        else workspace.setPropertyValue(row, def.id, value);
        touched = row;
      } else if (choice < 0.7) {
        const row = at(rows, Math.floor(rand() * rows.length));
        const view = at(schema.views, Math.floor(rand() * schema.views.length));
        const other = at(rows, Math.floor(rand() * rows.length));
        if (other === row) workspace.setRowOrder(row, view.id, { kind: 'first' });
        else
          workspace.setRowOrder(row, view.id, {
            kind: rand() < 0.5 ? 'before' : 'after',
            row: other,
          });
        // Keying may have touched other rows too: structural, so the full path below.
      } else if (choice < 0.72) {
        // Rare on purpose: every retype hides that property's values until it is undone.
        const def = at(schema.properties, Math.floor(rand() * schema.properties.length));
        const next = at(types, Math.floor(rand() * types.length));
        workspace.updateProperty(db.id, def.id, { type: next, name: `${def.name}*` });
      } else if (choice < 0.75) {
        const def = at(schema.properties, Math.floor(rand() * schema.properties.length));
        if (schema.properties.length > 2) workspace.removeProperty(db.id, def.id);
        else workspace.defineProperty(db.id, { name: `p${String(step)}`, type: 'text' });
      } else if (choice < 0.88) {
        const view = at(schema.views, Math.floor(rand() * schema.views.length));
        const sortable = schema.properties.filter((p) => p.type !== 'multi-select');
        const sortOn = sortable[Math.floor(rand() * sortable.length)];
        workspace.updateView(db.id, view.id, {
          name: `view ${String(step)}`,
          ...(sortOn === undefined ? {} : { sorts: [{ field: sortOn.id, direction: 'desc' }] }),
        });
        if (rand() < 0.3 && schema.views.length < 3) {
          workspace.createView(db.id, { name: `v${String(step)}`, type: 'table' });
        }
      } else if (choice < 0.96) {
        const row = at(rows, Math.floor(rand() * rows.length));
        const page = workspace.getPage(row);
        if (page.archivedAt === undefined) workspace.archivePage(row);
        else workspace.restorePage(row);
      } else {
        const archived = workspace.trash();
        const victim = archived[Math.floor(rand() * archived.length)];
        if (victim !== undefined) {
          workspace.deletePage(victim.id);
          rows.splice(rows.indexOf(victim.id), 1);
        }
      }

      // The hot path for a cell edit is upsertPage; everything else re-projects.
      if (touched !== undefined && rand() < 0.5) incremental.upsertPage(workspace.getPage(touched));
      else incremental.projectPages(workspace.allPages());

      if (step % 25 === 0) {
        const fresh = rebuilt(workspace);
        expect(incremental.contents(), `after step ${String(step)}`).toEqual(fresh.contents());
        fresh.close();
      }
    }

    const fresh = rebuilt(workspace);
    expect(incremental.contents()).toEqual(fresh.contents());
    expect(fresh.contents().propertyValues.length).toBeGreaterThan(10);
    expect(fresh.contents().rowOrder.length).toBeGreaterThan(5);
    incremental.close();
    fresh.close();
  });

  it('rewrites only the rows whose fingerprint changed', () => {
    const workspace = Workspace.create({ runtime: deterministicRuntime(2), peerId: 1n });
    const model = ReadModel.open(':memory:');
    const db = workspace.createPage({ title: 'Tasks' });
    workspace.convertToDatabase(db.id);
    const n = workspace.defineProperty(db.id, { name: 'N', type: 'number' });
    const rows = [1, 2, 3].map((i) =>
      workspace.createRow(db.id, { values: { [n.id]: { type: 'number', value: i } } }),
    );

    expect(model.projectPages(workspace.allPages())).toEqual({ pages: 4, rowsRewritten: 4 });
    // Nothing changed: the page table is replaced, the value tables are left alone.
    expect(model.projectPages(workspace.allPages())).toEqual({ pages: 4, rowsRewritten: 0 });
    // A rename changes no value: still nothing rewritten.
    workspace.renamePage(at(rows, 0).id, 'renamed');
    expect(model.projectPages(workspace.allPages()).rowsRewritten).toBe(0);
    // One cell edit: one row.
    workspace.setPropertyValue(at(rows, 1).id, n.id, { type: 'number', value: 20 });
    expect(model.projectPages(workspace.allPages()).rowsRewritten).toBe(1);
    model.close();
  });

  it('a retype hides values and a retype back restores them, in the tables too', () => {
    const workspace = Workspace.create({ runtime: deterministicRuntime(3), peerId: 1n });
    const model = ReadModel.open(':memory:');
    const db = workspace.createPage({ title: 'Tasks' });
    workspace.convertToDatabase(db.id);
    const n = workspace.defineProperty(db.id, { name: 'N', type: 'number' });
    const row = workspace.createRow(db.id, { values: { [n.id]: { type: 'number', value: 42 } } });

    model.projectPages(workspace.allPages());
    expect(model.contents().propertyValues).toEqual([
      expect.objectContaining({ pageId: row.id, kind: 'number', numValue: 42 }),
    ]);

    workspace.updateProperty(db.id, n.id, { type: 'text' });
    model.projectPages(workspace.allPages());
    expect(model.contents().propertyValues).toEqual([]);

    workspace.updateProperty(db.id, n.id, { type: 'number' });
    model.projectPages(workspace.allPages());
    expect(model.contents().propertyValues).toEqual([
      expect.objectContaining({ pageId: row.id, kind: 'number', numValue: 42 }),
    ]);
    model.close();
  });

  it("stores each kind in its typed column, with the engine's derived forms beside it", () => {
    const workspace = Workspace.create({ runtime: deterministicRuntime(4), peerId: 1n });
    const model = ReadModel.open(':memory:');
    const db = workspace.createPage({ title: 'Kinds' });
    workspace.convertToDatabase(db.id);
    const text = workspace.defineProperty(db.id, { name: 'T', type: 'text' });
    const dt = workspace.defineProperty(db.id, { name: 'D', type: 'datetime' });
    const multi = workspace.defineProperty(db.id, {
      name: 'M',
      type: 'multi-select',
      options: [{ name: 'a' }, { name: 'b' }],
    });
    const [a, b] = multi.options.map((o) => o.id);
    if (a === undefined || b === undefined) throw new Error('two options');
    const row = workspace.createRow(db.id, {
      values: {
        [text.id]: { type: 'text', value: 'Café' },
        // 23:30 UTC on the 10th is the 11th in Tokyo: the stored day is the value's own zone.
        [dt.id]: {
          type: 'datetime',
          value: { ms: Date.UTC(2026, 0, 10, 23, 30), zone: 'Asia/Tokyo' },
        },
        [multi.id]: { type: 'multi-select', value: [b, a] },
      },
    });
    model.projectPages(workspace.allPages());
    const values = model.contents().propertyValues;
    expect(values.find((v) => v.propertyId === text.id)).toMatchObject({
      textValue: 'Café',
      textFold: 'café',
    });
    expect(values.find((v) => v.propertyId === dt.id)).toMatchObject({
      intValue: Date.UTC(2026, 0, 10, 23, 30),
      textValue: '2026-01-11',
      jsonValue: '{"zone":"Asia/Tokyo"}',
    });
    // Multi-select membership is in schema order, as the engine canonicalises it.
    expect(model.contents().items.map((i) => i.optionId)).toEqual([a, b]);
    expect(values.find((v) => v.propertyId === multi.id)?.jsonValue).toBe(JSON.stringify([a, b]));
    expect(row.properties?.[multi.id]).toEqual({ type: 'multi-select', value: [a, b] });
    model.close();
  });

  it('upsertPage on a new page, then on the same page again, leaves what projectPages would', () => {
    const workspace = Workspace.create({ runtime: deterministicRuntime(5), peerId: 1n });
    const db = workspace.createPage({ title: 'Tasks' });
    workspace.convertToDatabase(db.id);
    const n = workspace.defineProperty(db.id, { name: 'N', type: 'number' });
    const model = ReadModel.open(':memory:');
    model.projectPages(workspace.allPages());

    const row = workspace.createRow(db.id, {
      title: 'new',
      values: { [n.id]: { type: 'number', value: 1 } },
    });
    model.upsertPage(workspace.getPage(row.id));
    workspace.setPropertyValue(row.id, n.id, { type: 'number', value: 2 });
    workspace.renamePage(row.id, 'renamed');
    model.upsertPage(workspace.getPage(row.id));

    const fresh = rebuilt(workspace);
    expect(model.contents()).toEqual(fresh.contents());
    expect(model.search('renamed').map((h) => h.id)).toEqual([row.id]);
    model.close();
    fresh.close();
  });
});
