/**
 * Rows: a database's children, with typed values on their own nodes.
 *
 * What is pinned here is the read path more than the write path. Values are stored
 * untagged and decoded through the PARENT's schema, so everything interesting happens
 * when the schema and the value disagree: a retype, a removed option, a row moved out of
 * its database and back. In every one of those the log is never rewritten, and the value
 * reappears when the schema fits again.
 */
import { describe, expect, it } from 'vitest';

import type { CalendarDate, PropertyDef, PropertyValue } from '../properties.js';
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

function rejectedWith(code: WorkspaceError['code']): Error {
  return expect.objectContaining({ code }) as Error;
}

/** A database with one property of every type. */
function fixture(w = ws()) {
  const db = w.createPage({ title: 'Everything' });
  w.convertToDatabase(db.id);
  const p = {
    text: w.defineProperty(db.id, { name: 'Text', type: 'text' }),
    number: w.defineProperty(db.id, { name: 'Number', type: 'number' }),
    checkbox: w.defineProperty(db.id, { name: 'Done', type: 'checkbox' }),
    select: w.defineProperty(db.id, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }, { name: 'Done' }],
    }),
    multi: w.defineProperty(db.id, {
      name: 'Tags',
      type: 'multi-select',
      options: [{ name: 'A' }, { name: 'B' }],
    }),
    date: w.defineProperty(db.id, { name: 'Due', type: 'date' }),
    datetime: w.defineProperty(db.id, { name: 'At', type: 'datetime' }),
    url: w.defineProperty(db.id, { name: 'Link', type: 'url' }),
  };
  return { w, db, p };
}

const option = (def: PropertyDef, index: number) => at(def.options, index).id;

describe('creating rows', () => {
  it('a row is a child page whose values fit the schema', () => {
    const { w, db, p } = fixture();
    const values: Record<string, PropertyValue> = {
      [p.text.id]: { type: 'text', value: 'Buy flour' },
      [p.number.id]: { type: 'number', value: 2 },
      [p.checkbox.id]: { type: 'checkbox', value: true },
      [p.select.id]: { type: 'select', value: option(p.select, 0) },
      [p.multi.id]: { type: 'multi-select', value: [option(p.multi, 1)] },
      [p.date.id]: { type: 'date', value: '2026-09-17' as CalendarDate },
      [p.datetime.id]: { type: 'datetime', value: { ms: 1_700_000_000_000, zone: 'UTC' } },
      [p.url.id]: { type: 'url', value: 'https://example.test' },
    };
    const row = w.createRow(db.id, { title: 'Flour', values });
    expect(row.parentId).toBe(db.id);
    expect(row.title).toBe('Flour');
    expect(row.properties).toEqual(values);
    expect(row.database).toBeUndefined();

    // The same through every read path, so the read model and the sidebar agree.
    expect(w.getPage(row.id).properties).toEqual(values);
    expect(
      must(
        w.allPages().find((page) => page.id === row.id),
        'row',
      ).properties,
    ).toEqual(values);
    expect(at(w.rows(db.id), 0).properties).toEqual(values);
    expect(at(at(w.tree(), 0).children, 0).properties).toEqual(values);
  });

  it('a row without values has an empty property bag; an ordinary page has none', () => {
    const { w, db } = fixture();
    const row = w.createRow(db.id);
    expect(row.title).toBe('Untitled');
    expect(row.properties).toEqual({});
    const plain = w.createPage({ title: 'Plain' });
    expect(plain.properties).toBeUndefined();
    expect(() => w.createRow(plain.id)).toThrow(rejectedWith('NOT_A_DATABASE'));
  });

  it('existing children of a converted page read as rows', () => {
    const w = ws();
    const parent = w.createPage({ title: 'Projects' });
    const child = w.createPage({ parentId: parent.id, title: 'Old child' });
    expect(w.getPage(child.id).properties).toBeUndefined();
    w.convertToDatabase(parent.id);
    expect(w.getPage(child.id).properties).toEqual({});
  });
});

describe('setting values', () => {
  it('sets, replaces and clears a cell', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id);
    w.setPropertyValue(row.id, p.number.id, { type: 'number', value: 1 });
    expect(
      w.setPropertyValue(row.id, p.number.id, { type: 'number', value: 2 }).properties,
    ).toEqual({
      [p.number.id]: { type: 'number', value: 2 },
    });
    expect(w.clearPropertyValue(row.id, p.number.id).properties).toEqual({});
    // Clearing what is already clear is not an error, and clearing on a row that never
    // had a values map writes nothing.
    const bare = w.createRow(db.id);
    expect(w.clearPropertyValue(bare.id, p.number.id).properties).toEqual({});
  });

  it('an empty text clears, so empty and absent are one state', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id, { values: { [p.text.id]: { type: 'text', value: 'x' } } });
    expect(w.setPropertyValue(row.id, p.text.id, { type: 'text', value: '' }).properties).toEqual(
      {},
    );
  });

  it('refuses the wrong tag, an unknown property, a bad payload, and a non-row', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id);
    expect(() => w.setPropertyValue(row.id, p.number.id, { type: 'text', value: 'x' })).toThrow(
      rejectedWith('INVALID_VALUE'),
    );
    expect(() =>
      w.setPropertyValue(row.id, p.number.id, { type: 'number', value: Number.NaN }),
    ).toThrow(rejectedWith('INVALID_VALUE'));
    expect(() => w.setPropertyValue(row.id, row.uuid, { type: 'text', value: 'x' })).toThrow(
      rejectedWith('UNKNOWN_PROPERTY'),
    );
    expect(() => w.setPropertyValue(db.id, p.text.id, { type: 'text', value: 'x' })).toThrow(
      rejectedWith('NOT_A_DATABASE'),
    );
    expect(() => w.setPropertyValue('999@999', p.text.id, { type: 'text', value: 'x' })).toThrow(
      rejectedWith('NOT_FOUND'),
    );
    // The failed write left nothing behind.
    expect(w.getPage(row.id).properties).toEqual({});
  });

  it("bumps the row's updatedAt, not the database's", () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id);
    const before = { row: w.getPage(row.id).updatedAt, db: w.getPage(db.id).updatedAt };
    w.setPropertyValue(row.id, p.checkbox.id, { type: 'checkbox', value: true });
    expect(w.getPage(row.id).updatedAt).toBeGreaterThan(before.row);
    expect(w.getPage(db.id).updatedAt).toBe(before.db);
  });
});

describe('when the schema and a value disagree', () => {
  it('a retype hides the value; retyping back shows it again, unchanged', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id, { values: { [p.number.id]: { type: 'number', value: 42 } } });
    w.updateProperty(db.id, p.number.id, { type: 'text' });
    expect(w.getPage(row.id).properties).toEqual({});
    w.updateProperty(db.id, p.number.id, { type: 'number' });
    expect(w.getPage(row.id).properties).toEqual({ [p.number.id]: { type: 'number', value: 42 } });
  });

  it('a removed option hides a select value; adding options does not bring the old id back', () => {
    const { w, db, p } = fixture();
    const todo = option(p.select, 0);
    const row = w.createRow(db.id, { values: { [p.select.id]: { type: 'select', value: todo } } });
    w.removeOption(db.id, p.select.id, todo);
    expect(w.getPage(row.id).properties).toEqual({});
    w.addOption(db.id, p.select.id, { name: 'Todo again' });
    expect(w.getPage(row.id).properties).toEqual({}); // a new option is a new id
  });

  it('a removed property hides its values on every row, and a new property starts empty', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id, {
      values: { [p.text.id]: { type: 'text', value: 'kept in the log' } },
    });
    w.removeProperty(db.id, p.text.id);
    expect(w.getPage(row.id).properties).toEqual({});
    const again = w.defineProperty(db.id, { name: 'Text', type: 'text' });
    expect(again.id).not.toBe(p.text.id);
    expect(w.getPage(row.id).properties).toEqual({});
  });

  it('a row moved out of its database loses its values, and regains them when moved back', () => {
    const { w, db, p } = fixture();
    const elsewhere = w.createPage({ title: 'Elsewhere' });
    const row = w.createRow(db.id, {
      values: { [p.text.id]: { type: 'text', value: 'still here' } },
    });
    w.movePage(row.id, elsewhere.id);
    expect(w.getPage(row.id).properties).toBeUndefined();
    expect(() => w.setPropertyValue(row.id, p.text.id, { type: 'text', value: 'no' })).toThrow(
      rejectedWith('NOT_A_DATABASE'),
    );
    w.movePage(row.id, db.id);
    expect(w.getPage(row.id).properties).toEqual({
      [p.text.id]: { type: 'text', value: 'still here' },
    });
  });
});

describe('listing rows', () => {
  it('lists live rows in sidebar order and leaves archived rows out unless asked', () => {
    const { w, db } = fixture();
    const a = w.createRow(db.id, { title: 'a' });
    const b = w.createRow(db.id, { title: 'b' });
    const c = w.createRow(db.id, { title: 'c' });
    w.archivePage(b.id);
    expect(w.rows(db.id).map((r) => r.id)).toEqual([a.id, c.id]);
    expect(w.rows(db.id, { includeArchived: true }).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    const plain = w.createPage({ title: 'Plain' });
    expect(() => w.rows(plain.id)).toThrow(rejectedWith('NOT_A_DATABASE'));
  });

  it('a nested database: a row that is itself a database carries both', () => {
    const { w, db, p } = fixture();
    const row = w.createRow(db.id, { values: { [p.text.id]: { type: 'text', value: 'outer' } } });
    w.convertToDatabase(row.id);
    const page = w.getPage(row.id);
    expect(page.properties).toEqual({ [p.text.id]: { type: 'text', value: 'outer' } });
    expect(page.database?.views).toHaveLength(1);
  });
});

describe('two devices', () => {
  function pair() {
    const origin = fixture(ws(1, 1n));
    const row = origin.w.createRow(origin.db.id, { title: 'Shared row' });
    const snapshot = origin.w.snapshot();
    const a = Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n });
    const b = Workspace.open(snapshot, { runtime: deterministicRuntime(3), peerId: 3n });
    const exchange = () => {
      const fromA = a.update();
      const fromB = b.update();
      a.merge(fromB);
      b.merge(fromA);
    };
    return { ...origin, row, a, b, exchange };
  }

  it('different properties of one row set apart both survive', () => {
    const { row, p, a, b, exchange } = pair();
    a.setPropertyValue(row.id, p.text.id, { type: 'text', value: 'from A' });
    b.setPropertyValue(row.id, p.number.id, { type: 'number', value: 7 });
    exchange();
    const expected = {
      [p.text.id]: { type: 'text', value: 'from A' },
      [p.number.id]: { type: 'number', value: 7 },
    };
    expect(a.getPage(row.id).properties).toEqual(expected);
    expect(b.getPage(row.id).properties).toEqual(expected);
  });

  it('the same property set apart converges to one value on both', () => {
    const { row, p, a, b, exchange } = pair();
    a.setPropertyValue(row.id, p.text.id, { type: 'text', value: 'A' });
    b.setPropertyValue(row.id, p.text.id, { type: 'text', value: 'B' });
    exchange();
    expect(a.getPage(row.id).properties).toEqual(b.getPage(row.id).properties);
    expect(Object.keys(must(a.getPage(row.id).properties, 'props'))).toEqual([p.text.id]);
  });

  it('a value set on one device against a property retyped on the other reads consistently', () => {
    const { db, row, p, a, b, exchange } = pair();
    a.setPropertyValue(row.id, p.number.id, { type: 'number', value: 3 });
    b.updateProperty(db.id, p.number.id, { type: 'text' });
    exchange();
    // Both see the retype; both hide the number until the type comes back.
    expect(a.getPage(row.id).properties).toEqual({});
    expect(b.getPage(row.id).properties).toEqual({});
    a.updateProperty(db.id, p.number.id, { type: 'number' });
    exchange();
    expect(b.getPage(row.id).properties).toEqual({ [p.number.id]: { type: 'number', value: 3 } });
  });

  it('rows created apart both appear, and merging is order independent', () => {
    const { db, a, b, exchange } = pair();
    a.createRow(db.id, { title: 'from A' });
    b.createRow(db.id, { title: 'from B' });
    exchange();
    const titles = (w: Workspace) =>
      w
        .rows(db.id)
        .map((r) => r.title)
        .sort();
    expect(titles(a)).toEqual(['Shared row', 'from A', 'from B']);
    expect(titles(b)).toEqual(titles(a));
  });
});
