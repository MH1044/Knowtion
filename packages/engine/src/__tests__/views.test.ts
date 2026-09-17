/**
 * Views and manual row order.
 *
 * A view's semantics live in the CRDT with one key per field; a row's position in a view
 * is a key stored on the row. The rules pinned here are the ones a user would notice
 * breaking: a board must have a select property to make columns of, a database always
 * keeps a view, a saved filter must fit the schema, a dragged row lands exactly where it
 * was dropped in one view and nowhere else, and two devices reordering apart converge on
 * the same order.
 */
import { describe, expect, it } from 'vitest';

import type { PropertyDef, ViewId } from '../properties.js';
import { deterministicRuntime } from '../runtime.js';
import { WorkspaceError, type NodeId } from '../types.js';
import { Workspace } from '../workspace.js';

const ws = (seed = 1, peerId = 1n) =>
  Workspace.create({ runtime: deterministicRuntime(seed), peerId });

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

function rejectedWith(code: WorkspaceError['code']): Error {
  return expect.objectContaining({ code }) as Error;
}

const option = (def: PropertyDef, index: number) => at(def.options, index).id;

/** A database with a select property, a text property and four rows a..d. */
function fixture(w = ws()) {
  const db = w.createPage({ title: 'Board' });
  w.convertToDatabase(db.id);
  const status = w.defineProperty(db.id, {
    name: 'Status',
    type: 'select',
    options: [{ name: 'Todo' }, { name: 'Done' }],
  });
  const text = w.defineProperty(db.id, { name: 'Text', type: 'text' });
  const rows = ['a', 'b', 'c', 'd'].map((title) => w.createRow(db.id, { title }));
  const table = at(w.database(db.id).views, 0);
  const order = (viewId: ViewId) =>
    w
      .rows(db.id, { viewId })
      .map((r) => r.title)
      .join('');
  return { w, db, status, text, rows, table, order };
}

describe('views', () => {
  it('creates a table and a board, each carrying every property as a column', () => {
    const { w, db, status, text } = fixture();
    const board = w.createView(db.id, { name: 'By status', type: 'board', groupBy: status.id });
    expect(board).toMatchObject({ name: 'By status', type: 'board', groupBy: status.id });
    expect(board.columns).toEqual([status.id, text.id]);
    expect(w.database(db.id).views.map((v) => v.name)).toEqual(['Table', 'By status']);
  });

  it('a board must group by a select property', () => {
    const { w, db, text } = fixture();
    expect(() => w.createView(db.id, { name: 'B', type: 'board' })).toThrow(
      rejectedWith('INVALID_VIEW'),
    );
    expect(() => w.createView(db.id, { name: 'B', type: 'board', groupBy: text.id })).toThrow(
      rejectedWith('INVALID_VIEW'),
    );
    expect(() => w.createView(db.id, { name: 'B', type: 'board', groupBy: db.uuid })).toThrow(
      rejectedWith('UNKNOWN_PROPERTY'),
    );
    expect(() => w.createView(db.id, { name: ' ', type: 'table' })).toThrow(
      rejectedWith('INVALID_SCHEMA'),
    );
  });

  it('updates fields independently, and validates the result against the schema', () => {
    const { w, db, status, text, table } = fixture();
    const updated = w.updateView(db.id, table.id, {
      name: 'Open',
      filter: {
        v: 1,
        expr: { kind: 'leaf', property: status.id, op: 'optionIs', value: option(status, 0) },
      },
      sorts: [{ field: text.id, direction: 'desc' }],
      hidden: [text.id],
      columns: [text.id, status.id],
    });
    expect(updated).toMatchObject({
      name: 'Open',
      sorts: [{ field: text.id, direction: 'desc' }],
      hidden: [text.id],
      columns: [text.id, status.id],
    });
    expect(updated.filter?.expr).toMatchObject({ op: 'optionIs' });

    // Clearing with null; leaving fields alone by omission.
    const cleared = w.updateView(db.id, table.id, { filter: null });
    expect(cleared.filter).toBeUndefined();
    expect(cleared.sorts).toEqual([{ field: text.id, direction: 'desc' }]);

    expect(() =>
      w.updateView(db.id, table.id, {
        filter: { v: 1, expr: { kind: 'leaf', property: db.uuid, op: 'isEmpty' } },
      }),
    ).toThrow(rejectedWith('INVALID_VIEW'));
    expect(() =>
      w.updateView(db.id, table.id, {
        filter: { v: 1, expr: { kind: 'leaf', property: text.id, op: 'gt', value: 1 } },
      }),
    ).toThrow(rejectedWith('INVALID_VIEW'));
    expect(() =>
      w.updateView(db.id, table.id, {
        filter: { v: 99, expr: { kind: 'leaf', property: text.id, op: 'isEmpty' } },
      }),
    ).toThrow(rejectedWith('INVALID_VIEW'));
    expect(() => w.updateView(db.id, table.id, { type: 'board' })).toThrow(
      rejectedWith('INVALID_VIEW'),
    );
    expect(() => w.updateView(db.id, table.id, { columns: [db.uuid] })).toThrow(
      rejectedWith('UNKNOWN_PROPERTY'),
    );
    expect(() => w.updateView(db.id, db.uuid, { name: 'x' })).toThrow(rejectedWith('UNKNOWN_VIEW'));
  });

  it('a database keeps at least one view', () => {
    const { w, db, table } = fixture();
    expect(() => {
      w.removeView(db.id, table.id);
    }).toThrow(rejectedWith('INVALID_VIEW'));
    const second = w.createView(db.id, { name: 'Second', type: 'table' });
    w.removeView(db.id, table.id);
    expect(w.database(db.id).views.map((v) => v.id)).toEqual([second.id]);
    expect(() => {
      w.removeView(db.id, table.id);
    }).toThrow(rejectedWith('UNKNOWN_VIEW'));
  });
});

describe('manual order', () => {
  it('unordered rows come in creation order and carry no keys', () => {
    const { w, rows, table, order } = fixture();
    expect(order(table.id)).toBe('abcd');
    for (const row of rows) expect(w.getPage(row.id).orderKeys).toEqual({});
  });

  it('first, last, before and after each land exactly where dropped', () => {
    const { w, rows, table, order } = fixture();
    const [a, b, c, d] = rows.map((r) => r.id) as [NodeId, NodeId, NodeId, NodeId];

    w.setRowOrder(d, table.id, { kind: 'first' });
    expect(order(table.id)).toBe('dabc');
    w.setRowOrder(a, table.id, { kind: 'last' });
    expect(order(table.id)).toBe('dbca');
    w.setRowOrder(c, table.id, { kind: 'before', row: b });
    expect(order(table.id)).toBe('dcba');
    w.setRowOrder(d, table.id, { kind: 'after', row: b });
    expect(order(table.id)).toBe('cbda');
  });

  it('dropping among unkeyed rows keys the rows before the drop point, and says which', () => {
    // Unkeyed rows sort after every keyed row. For a row to land after an unkeyed one,
    // that one — and every unkeyed row before it — has to be keyed, without moving.
    const { w, rows, table, order } = fixture();
    const [a, b, c, d] = rows.map((r) => r.id) as [NodeId, NodeId, NodeId, NodeId];

    const result = w.setRowOrder(d, table.id, { kind: 'after', row: b });
    expect(order(table.id)).toBe('abdc');
    expect(result.keyed).toEqual([a, b]);
    expect(w.getPage(c).orderKeys).toEqual({}); // after the drop point: left alone

    // A later drop into the keyed region costs one write.
    expect(w.setRowOrder(c, table.id, { kind: 'before', row: d }).keyed).toEqual([]);
    expect(order(table.id)).toBe('abcd');
  });

  it('a key is stored on the row, for that view only', () => {
    const { w, db, rows, table, order } = fixture();
    const second = w.createView(db.id, { name: 'Second', type: 'table' });
    const d = at(rows, 3).id;
    w.setRowOrder(d, table.id, { kind: 'first' });
    expect(order(table.id)).toBe('dabc');
    expect(order(second.id)).toBe('abcd'); // FORMAT.md: keyed on (view, row), never the row alone
    expect(Object.keys(w.getPage(d).orderKeys ?? {})).toEqual([table.id]);
  });

  it('refuses a missing view, a missing anchor, placing against itself, and a non-row', () => {
    const { w, db, rows, table } = fixture();
    const a = at(rows, 0).id;
    expect(() => w.setRowOrder(a, db.uuid, { kind: 'first' })).toThrow(
      rejectedWith('UNKNOWN_VIEW'),
    );
    expect(() => w.setRowOrder(a, table.id, { kind: 'after', row: '999@999' })).toThrow(
      rejectedWith('NOT_FOUND'),
    );
    expect(() => w.setRowOrder(a, table.id, { kind: 'after', row: a })).toThrow(
      rejectedWith('INVALID_VIEW'),
    );
    expect(() => w.setRowOrder(db.id, table.id, { kind: 'first' })).toThrow(
      rejectedWith('NOT_A_DATABASE'),
    );
  });

  it('a deleted row takes its keys with it; the view is unaffected', () => {
    const { w, rows, table, order } = fixture();
    const d = at(rows, 3).id;
    w.setRowOrder(d, table.id, { kind: 'first' });
    w.archivePage(d);
    expect(order(table.id)).toBe('abc');
    w.deletePage(d);
    expect(order(table.id)).toBe('abc');
  });
});

describe('moving a card', () => {
  it('sets the group value and places the row, in one commit', () => {
    const { w, db, status, rows, order } = fixture();
    const board = w.createView(db.id, { name: 'Board', type: 'board', groupBy: status.id });
    const todo = option(status, 0);
    const [a, b] = rows.map((r) => r.id) as [NodeId, NodeId];
    const version = w.doc.version().toJSON();

    w.moveCard(b, board.id, todo, { kind: 'first' });
    expect(w.getPage(b).properties).toEqual({ [status.id]: { type: 'select', value: todo } });
    expect(order(board.id)).toBe('bacd');

    // One commit: our peer's counter advanced once, not once per write.
    const after = w.doc.version().toJSON();
    expect(after.size).toBe(version.size);

    w.moveCard(b, board.id, null, { kind: 'after', row: a });
    expect(w.getPage(b).properties).toEqual({});
    expect(order(board.id)).toBe('abcd');
  });

  it('refuses on a table or with an option the property lacks', () => {
    const { w, db, status, rows, table } = fixture();
    const a = at(rows, 0).id;
    expect(() => w.moveCard(a, table.id, option(status, 0), { kind: 'first' })).toThrow(
      rejectedWith('INVALID_VIEW'),
    );
    const board = w.createView(db.id, { name: 'Board', type: 'board', groupBy: status.id });
    expect(() => w.moveCard(a, board.id, db.uuid, { kind: 'first' })).toThrow(
      rejectedWith('INVALID_VALUE'),
    );
  });
});

describe('the collapsed tree', () => {
  it('leaves rows out of a database node and counts them instead', () => {
    const { w, db, rows } = fixture();
    w.archivePage(at(rows, 0).id);
    const full = w.tree();
    expect(at(full, 0).children).toHaveLength(3);
    expect(at(full, 0).rowCount).toBeUndefined();

    const collapsed = w.tree({ collapseDatabases: true });
    expect(at(collapsed, 0).id).toBe(db.id);
    expect(at(collapsed, 0).children).toEqual([]);
    expect(at(collapsed, 0).rowCount).toBe(3);

    // An ordinary page keeps its children either way.
    const parent = w.createPage({ title: 'Plain parent' });
    w.createPage({ parentId: parent.id, title: 'child' });
    const node = w.tree({ collapseDatabases: true }).find((n) => n.id === parent.id);
    expect(node?.children).toHaveLength(1);
    expect(node?.rowCount).toBeUndefined();
  });
});

describe('two devices', () => {
  function pair() {
    const origin = fixture(ws(1, 1n));
    const snapshot = origin.w.snapshot();
    const a = Workspace.open(snapshot, { runtime: deterministicRuntime(2), peerId: 2n });
    const b = Workspace.open(snapshot, { runtime: deterministicRuntime(3), peerId: 3n });
    const exchange = () => {
      const fromA = a.update();
      const fromB = b.update();
      a.merge(fromB);
      b.merge(fromA);
    };
    const orderOn = (w: Workspace) =>
      w
        .rows(origin.db.id, { viewId: origin.table.id })
        .map((r) => r.title)
        .join('');
    return { ...origin, a, b, exchange, orderOn };
  }

  it('edits to different fields of one view both survive', () => {
    const { db, table, status, text, a, b, exchange } = pair();
    a.updateView(db.id, table.id, {
      filter: { v: 1, expr: { kind: 'leaf', property: status.id, op: 'isEmpty' } },
    });
    b.updateView(db.id, table.id, { columns: [text.id, status.id], name: 'Renamed' });
    exchange();
    const onA = at(a.database(db.id).views, 0);
    expect(onA.filter?.expr).toMatchObject({ op: 'isEmpty' });
    expect(onA.columns).toEqual([text.id, status.id]);
    expect(onA.name).toBe('Renamed');
    expect(b.database(db.id).views).toEqual(a.database(db.id).views);
  });

  it('reorders made apart converge to one order on both devices', () => {
    const { rows, table, a, b, exchange, orderOn } = pair();
    const [aId, , cId] = rows.map((r) => r.id) as [NodeId, NodeId, NodeId, NodeId];
    a.setRowOrder(cId, table.id, { kind: 'first' });
    b.setRowOrder(aId, table.id, { kind: 'last' });
    exchange();
    expect(orderOn(a)).toBe(orderOn(b));
    expect(orderOn(a)).toHaveLength(4);

    // The same row dragged on both devices: last writer wins, both agree.
    a.setRowOrder(cId, table.id, { kind: 'last' });
    b.setRowOrder(cId, table.id, { kind: 'first' });
    exchange();
    expect(orderOn(a)).toBe(orderOn(b));
  });

  it('the order is the same whatever order the updates arrive in', () => {
    const { rows, table, w, db, a, b } = pair();
    const [aId, bId, cId, dId] = rows.map((r) => r.id) as [NodeId, NodeId, NodeId, NodeId];
    a.setRowOrder(dId, table.id, { kind: 'first' });
    b.setRowOrder(aId, table.id, { kind: 'before', row: cId });
    const fromA = a.update();
    const fromB = b.update();
    const c = Workspace.open(w.snapshot(), { runtime: deterministicRuntime(4), peerId: 4n });
    const d = Workspace.open(w.snapshot(), { runtime: deterministicRuntime(5), peerId: 5n });
    c.merge(fromA);
    c.merge(fromB);
    d.merge(fromB);
    d.merge(fromA);
    const orderOf = (x: Workspace) => x.rows(db.id, { viewId: table.id }).map((r) => r.id);
    expect(orderOf(c)).toEqual(orderOf(d));
    expect(new Set(orderOf(c))).toEqual(new Set([aId, bId, cId, dId]));
  });
});
