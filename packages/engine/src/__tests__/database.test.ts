/**
 * A page becomes a database: its schema on its own node, read back through the same
 * possibly-absent convention as everything else in node data.
 *
 * The rules pinned here are ADR-0014's: converting is idempotent and makes a default
 * table view; properties and options are identified by UUIDv7 and sorted by creation;
 * a retype hides values rather than destroying them (the codec's business, but the
 * schema must let it happen); removing a property scrubs every view of it; and a view's
 * effective columns always include every live property.
 */
import { describe, expect, it } from 'vitest';

import { DB_KEY } from '../database.js';
import type { PropertyDef } from '../properties.js';
import { deterministicRuntime } from '../runtime.js';
import { WorkspaceError } from '../types.js';
import { Workspace } from '../workspace.js';

const ws = (seed = 1, peerId = 1n) =>
  Workspace.create({ runtime: deterministicRuntime(seed), peerId });

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

/** Unwraps a lookup the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** vitest types `expect.objectContaining` as `any`; this gives the matcher an honest type. */
function rejectedWith(code: WorkspaceError['code']): Error {
  return expect.objectContaining({ code }) as Error;
}

const names = (properties: PropertyDef[]) => properties.map((p) => p.name);

function database(w = ws()) {
  const page = w.createPage({ title: 'Tasks' });
  const schema = w.convertToDatabase(page.id);
  return { w, page, schema };
}

describe('becoming a database', () => {
  it('an ordinary page is not a database, and asking for its schema says so', () => {
    const w = ws();
    const page = w.createPage({ title: 'Notes' });
    expect(w.isDatabase(page.id)).toBe(false);
    expect(w.getPage(page.id).database).toBeUndefined();
    expect(() => w.database(page.id)).toThrow(rejectedWith('NOT_A_DATABASE'));
    expect(() => w.database('999@999')).toThrow(rejectedWith('NOT_FOUND'));
  });

  it('converting makes one default table view and is idempotent', () => {
    const { w, page, schema } = database();
    expect(w.isDatabase(page.id)).toBe(true);
    expect(schema.properties).toEqual([]);
    expect(schema.views).toHaveLength(1);
    expect(at(schema.views, 0)).toMatchObject({
      name: 'Table',
      type: 'table',
      columns: [],
      hidden: [],
    });
    expect(schema.createdAt).toBeGreaterThan(0);

    const again = w.convertToDatabase(page.id);
    expect(again.views).toHaveLength(1);
    expect(again.createdAt).toBe(schema.createdAt);
    expect(w.getPage(page.id).database).toEqual(again);
  });

  it('existing children become rows without changing', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Projects' });
    const child = w.createPage({ parentId: parent.id, title: 'Knowtion' });
    w.convertToDatabase(parent.id);
    expect(w.getPage(child.id).title).toBe('Knowtion');
    expect(w.getPage(child.id).parentId).toBe(parent.id);
    expect(w.listChildren(parent.id).map((p) => p.id)).toEqual([child.id]);
  });

  it('the schema travels with the page through archive, restore and move', () => {
    const w = ws();
    const other = w.createPage({ title: 'Elsewhere' });
    const { page } = database(w);
    w.defineProperty(page.id, { name: 'Done', type: 'checkbox' });

    w.archivePage(page.id);
    expect(w.database(page.id).properties).toHaveLength(1);
    w.restorePage(page.id);
    w.movePage(page.id, other.id);
    expect(names(w.database(page.id).properties)).toEqual(['Done']);
  });

  it('refuses to treat a scalar under the database key as a schema', () => {
    // Only corrupted or hostile data can do this; it must be a reported error, not a
    // throw from inside the CRDT.
    const w = ws();
    const page = w.createPage({ title: 'Odd' });
    const node = must(w.doc.getTree('pages').getNodeByID(page.id), 'the node');
    node.data.set(DB_KEY, 42);
    w.doc.commit();
    expect(w.getPage(page.id).database).toBeUndefined();
    expect(() => w.convertToDatabase(page.id)).toThrow(rejectedWith('INVALID_SCHEMA'));
  });
});

describe('properties', () => {
  it('defines one of each type, in creation order, with UUIDv7 ids', () => {
    const { w, page } = database();
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
    for (const type of types) w.defineProperty(page.id, { name: type, type });
    const schema = w.database(page.id);
    expect(schema.properties.map((p) => p.type)).toEqual([...types]);
    for (const property of schema.properties) {
      expect(property.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(property.options).toEqual([]);
      expect(property.createdAt).toBeGreaterThan(0);
    }
  });

  it('refuses a nameless property and options on a type that has none', () => {
    const { w, page } = database();
    expect(() => w.defineProperty(page.id, { name: '  ', type: 'text' })).toThrow(
      rejectedWith('INVALID_SCHEMA'),
    );
    expect(() =>
      w.defineProperty(page.id, { name: 'N', type: 'number', options: [{ name: 'x' }] }),
    ).toThrow(rejectedWith('INVALID_SCHEMA'));
    expect(() => w.defineProperty('999@999', { name: 'N', type: 'text' })).toThrow(
      rejectedWith('NOT_FOUND'),
    );
    const plain = w.createPage({ title: 'not a db' });
    expect(() => w.defineProperty(plain.id, { name: 'N', type: 'text' })).toThrow(
      rejectedWith('NOT_A_DATABASE'),
    );
  });

  it('a select property carries its options in creation order, with colours', () => {
    const { w, page } = database();
    const status = w.defineProperty(page.id, {
      name: 'Status',
      type: 'select',
      options: [
        { name: 'Todo', color: 'gray' },
        { name: 'Done', color: 'green' },
      ],
    });
    expect(status.options.map((o) => o.name)).toEqual(['Todo', 'Done']);
    expect(at(status.options, 1).color).toBe('green');
    expect(at(status.options, 0).id).not.toBe(at(status.options, 1).id);
  });

  it('renames and retypes; a retype keeps the options for a return to select', () => {
    const { w, page } = database();
    const status = w.defineProperty(page.id, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    expect(w.updateProperty(page.id, status.id, { name: 'State' }).name).toBe('State');

    const asText = w.updateProperty(page.id, status.id, { type: 'text' });
    expect(asText.type).toBe('text');
    expect(asText.options).toEqual([]); // not shown under a type that has none

    const back = w.updateProperty(page.id, status.id, { type: 'select' });
    expect(back.options.map((o) => o.name)).toEqual(['Todo']); // and not lost

    expect(() => w.updateProperty(page.id, status.id, { name: '' })).toThrow(
      rejectedWith('INVALID_SCHEMA'),
    );
    expect(() => w.updateProperty(page.id, at(w.allPages(), 0).uuid, { name: 'x' })).toThrow(
      rejectedWith('UNKNOWN_PROPERTY'),
    );
  });

  it('removing a property removes it, its options, and every view reference to it', () => {
    const { w, page } = database();
    const status = w.defineProperty(page.id, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    const due = w.defineProperty(page.id, { name: 'Due', type: 'date' });
    // Simulate a view that leans on Status everywhere it can.
    const viewId = at(w.database(page.id).views, 0).id;
    const node = must(w.doc.getTree('pages').getNodeByID(page.id), 'the node');
    const view = node.data
      .ensureMergeableMap(DB_KEY)
      .ensureMergeableMap('views')
      .ensureMergeableMap(viewId);
    view.set('columns', [status.id, due.id]);
    view.set('hidden', [status.id]);
    view.set('sorts', [{ field: status.id, direction: 'asc' }]);
    view.set('groupBy', status.id);
    view.set('filter', {
      v: 1,
      expr: {
        kind: 'and',
        clauses: [
          { kind: 'leaf', property: status.id, op: 'isEmpty' },
          { kind: 'leaf', property: due.id, op: 'isEmpty' },
        ],
      },
    });
    w.doc.commit();

    w.removeProperty(page.id, status.id);
    const schema = w.database(page.id);
    expect(names(schema.properties)).toEqual(['Due']);
    const after = at(schema.views, 0);
    expect(after.columns).toEqual([due.id]);
    expect(after.hidden).toEqual([]);
    expect(after.sorts).toEqual([]);
    expect(after.groupBy).toBeUndefined();
    expect(after.filter?.expr).toEqual({
      kind: 'and',
      clauses: [{ kind: 'leaf', property: due.id, op: 'isEmpty' }],
    });
    expect(() => {
      w.removeProperty(page.id, status.id);
    }).toThrow(rejectedWith('UNKNOWN_PROPERTY'));
  });
});

describe('options', () => {
  it('adds, renames, recolours and removes options on a select property', () => {
    const { w, page } = database();
    const tags = w.defineProperty(page.id, { name: 'Tags', type: 'multi-select' });
    const a = w.addOption(page.id, tags.id, { name: 'A' });
    const b = w.addOption(page.id, tags.id, { name: 'B', color: 'blue' });
    expect(must(w.database(page.id).properties[0], 'tags').options.map((o) => o.name)).toEqual([
      'A',
      'B',
    ]);

    expect(w.updateOption(page.id, tags.id, a.id, { name: 'Alpha', color: 'red' })).toEqual({
      id: a.id,
      name: 'Alpha',
      color: 'red',
    });
    expect(w.updateOption(page.id, tags.id, b.id, { color: null })).toEqual({
      id: b.id,
      name: 'B',
    });

    w.removeOption(page.id, tags.id, a.id);
    expect(must(w.database(page.id).properties[0], 'tags').options.map((o) => o.name)).toEqual([
      'B',
    ]);
    expect(() => {
      w.removeOption(page.id, tags.id, a.id);
    }).toThrow(rejectedWith('INVALID_SCHEMA'));
  });

  it('refuses options on a property that has none, and nameless options', () => {
    const { w, page } = database();
    const n = w.defineProperty(page.id, { name: 'N', type: 'number' });
    expect(() => w.addOption(page.id, n.id, { name: 'x' })).toThrow(rejectedWith('INVALID_SCHEMA'));
    const s = w.defineProperty(page.id, { name: 'S', type: 'select' });
    expect(() => w.addOption(page.id, s.id, { name: ' ' })).toThrow(rejectedWith('INVALID_SCHEMA'));
  });
});

describe('the default view', () => {
  it('shows every live property, in schema order, even though nothing was written to it', () => {
    // The read rule that makes concurrent property definitions safe: columns are the
    // stored order plus every live property missing from it.
    const { w, page } = database();
    const a = w.defineProperty(page.id, { name: 'A', type: 'text' });
    const b = w.defineProperty(page.id, { name: 'B', type: 'number' });
    const view = at(w.database(page.id).views, 0);
    expect(view.columns).toEqual([a.id, b.id]);
    expect(view.hidden).toEqual([]);
    expect(view.sorts).toEqual([]);
    expect(view.filter).toBeUndefined();
    expect(view.groupBy).toBeUndefined();
  });
});

describe('two devices', () => {
  /** Two devices seeded from one snapshot holding one database. */
  function pair() {
    const origin = ws(1, 1n);
    const page = origin.createPage({ title: 'Tasks' });
    origin.convertToDatabase(page.id);
    const snapshot = origin.snapshot();
    const a = Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n });
    const b = Workspace.open(snapshot, { runtime: deterministicRuntime(3), peerId: 3n });
    const exchange = () => {
      const fromA = a.update();
      const fromB = b.update();
      a.merge(fromB);
      b.merge(fromA);
    };
    return { page, a, b, exchange };
  }

  it('properties defined apart both survive, on both devices', () => {
    const { page, a, b, exchange } = pair();
    a.defineProperty(page.id, { name: 'From A', type: 'text' });
    b.defineProperty(page.id, { name: 'From B', type: 'number' });
    exchange();
    expect(names(a.database(page.id).properties).sort()).toEqual(['From A', 'From B']);
    expect(b.database(page.id)).toEqual(a.database(page.id));
    // And the default view shows both, though neither device wrote to its columns.
    expect(at(a.database(page.id).views, 0).columns).toHaveLength(2);
  });

  it('a rename and a retype of the same property apart both survive', () => {
    const { page, a, b, exchange } = pair();
    const p = a.defineProperty(page.id, { name: 'Amount', type: 'text' });
    exchange();
    a.updateProperty(page.id, p.id, { name: 'Total' });
    b.updateProperty(page.id, p.id, { type: 'number' });
    exchange();
    expect(a.database(page.id).properties).toEqual(b.database(page.id).properties);
    expect(at(a.database(page.id).properties, 0)).toMatchObject({ name: 'Total', type: 'number' });
  });

  it('renames of different options both survive; the same option converges', () => {
    const { page, a, b, exchange } = pair();
    const status = a.defineProperty(page.id, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'One' }, { name: 'Two' }],
    });
    exchange();
    const [one, two] = status.options;
    if (one === undefined || two === undefined) throw new Error('two options');

    a.updateOption(page.id, status.id, one.id, { name: 'Uno' });
    b.updateOption(page.id, status.id, two.id, { name: 'Dos' });
    exchange();
    const optionsOn = (w: Workspace) =>
      must(w.database(page.id).properties[0], 'status').options.map((o) => o.name);
    expect(optionsOn(a)).toEqual(['Uno', 'Dos']);
    expect(optionsOn(b)).toEqual(['Uno', 'Dos']);

    a.updateOption(page.id, status.id, one.id, { name: 'A wins?' });
    b.updateOption(page.id, status.id, one.id, { name: 'B wins?' });
    exchange();
    expect(optionsOn(a)).toEqual(optionsOn(b));
  });

  it('converting the same page apart yields a database on both, with both default views', () => {
    const origin = ws(1, 1n);
    const page = origin.createPage({ title: 'Later a database' });
    const snapshot = origin.snapshot();
    const a = Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n });
    const b = Workspace.open(snapshot, { runtime: deterministicRuntime(3), peerId: 3n });
    a.convertToDatabase(page.id);
    b.convertToDatabase(page.id);
    const fromA = a.update();
    a.merge(b.update());
    b.merge(fromA);
    expect(a.database(page.id)).toEqual(b.database(page.id));
    expect(a.database(page.id).views).toHaveLength(2);
  });
});
