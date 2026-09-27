/**
 * Relations: a row pointing at rows of another database, by uuid.
 *
 * ADR-0015 fixes the shape and the asymmetry pinned here. A relation is stored once, on
 * the row that owns it, as a list of target page uuids; the reverse direction is derived
 * and never written, so there is nothing for two devices to reconcile. The strict
 * question — is this target a row of the right database — is asked when a value is
 * written and never when one is read, because a target that has not synced yet is not
 * the same thing as a target that never existed, and a reader that could not tell them
 * apart would delete links for a living.
 */
import { describe, expect, it } from 'vitest';

import { ROW_PROPS_KEY } from '../database.js';
import type { PropertyDef, Uuid } from '../index.js';
import { deterministicRuntime } from '../runtime.js';
import { WorkspaceError, type NodeId } from '../types.js';
import { Workspace } from '../workspace.js';

const ws = (seed = 1, peerId = 1n) =>
  Workspace.create({ runtime: deterministicRuntime(seed), peerId });

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

function rejectedWith(code: WorkspaceError['code']): Error {
  return expect.objectContaining({ code }) as Error;
}

/** The row's `props` map as it actually sits in the log, past every reading rule. */
function storedProps(w: Workspace, rowId: NodeId): Record<string, unknown> {
  const node = must(w.doc.getTree('pages').getNodeByID(rowId), 'the node');
  const data = node.data.toJSON() as Record<string, unknown>;
  return (data[ROW_PROPS_KEY] ?? {}) as Record<string, unknown>;
}

/**
 * Two databases, People and Tasks, with Tasks.Owner pointing at People.
 *
 * Returned by uuid as well as by node id, because a relation names its target the way
 * the log does — by the identity that survives outside the tree.
 */
function fixture(w = ws()) {
  const people = w.createPage({ title: 'People' });
  w.convertToDatabase(people.id);
  const tasks = w.createPage({ title: 'Tasks' });
  w.convertToDatabase(tasks.id);
  const peopleUuid = w.getPage(people.id).uuid;
  const owner = w.defineProperty(tasks.id, {
    name: 'Owner',
    type: 'relation',
    config: { database: peopleUuid },
  });
  const ada = w.createRow(people.id, { title: 'Ada' });
  const grace = w.createRow(people.id, { title: 'Grace' });
  return { w, people, tasks, peopleUuid, owner, ada, grace };
}

describe('defining a relation', () => {
  it('stores the database it points at', () => {
    const { w, tasks, owner, peopleUuid } = fixture();
    expect(owner.config).toEqual({ database: peopleUuid });
    const reread = must(
      w.database(tasks.id).properties.find((p) => p.id === owner.id),
      'the property',
    );
    expect(reread.config).toEqual({ database: peopleUuid });
  });

  it('refuses a relation with no database, and a database that is not one', () => {
    const w = ws();
    const tasks = w.createPage({ title: 'Tasks' });
    w.convertToDatabase(tasks.id);
    const plain = w.createPage({ title: 'Just a page' });
    expect(() => w.defineProperty(tasks.id, { name: 'Owner', type: 'relation' })).toThrow(
      rejectedWith('INVALID_SCHEMA'),
    );
    expect(() =>
      w.defineProperty(tasks.id, {
        name: 'Owner',
        type: 'relation',
        config: { database: 'not a uuid' as Uuid },
      }),
    ).toThrow(rejectedWith('INVALID_SCHEMA'));
    expect(() =>
      w.defineProperty(tasks.id, {
        name: 'Owner',
        type: 'relation',
        config: { database: w.getPage(plain.id).uuid },
      }),
    ).toThrow(rejectedWith('NOT_A_DATABASE'));
  });

  it('refuses configuration on a type that has none', () => {
    const { w, tasks, peopleUuid } = fixture();
    expect(() =>
      w.defineProperty(tasks.id, {
        name: 'Note',
        type: 'text',
        config: { database: peopleUuid },
      }),
    ).toThrow(rejectedWith('INVALID_SCHEMA'));
  });

  it('may point a database at itself', () => {
    const w = ws();
    const tasks = w.createPage({ title: 'Tasks' });
    w.convertToDatabase(tasks.id);
    const blockedBy = w.defineProperty(tasks.id, {
      name: 'Blocked by',
      type: 'relation',
      config: { database: w.getPage(tasks.id).uuid },
    });
    const a = w.createRow(tasks.id, { title: 'a' });
    const b = w.createRow(tasks.id, { title: 'b' });
    w.setPropertyValue(a.id, blockedBy.id, {
      type: 'relation',
      value: [w.getPage(b.id).uuid],
    });
    expect(w.getPage(a.id).properties?.[blockedBy.id]).toEqual({
      type: 'relation',
      value: [w.getPage(b.id).uuid],
    });
  });
});

describe('writing targets', () => {
  it('keeps the order they were given and drops a repeat', () => {
    const { w, tasks, owner, ada, grace } = fixture();
    const adaUuid = w.getPage(ada.id).uuid;
    const graceUuid = w.getPage(grace.id).uuid;
    const task = w.createRow(tasks.id, { title: 'Ship it' });
    w.setPropertyValue(task.id, owner.id, {
      type: 'relation',
      value: [graceUuid, adaUuid, graceUuid],
    });
    expect(w.getPage(task.id).properties?.[owner.id]).toEqual({
      type: 'relation',
      value: [graceUuid, adaUuid],
    });
  });

  it('refuses a target that is not a row of the database it points at', () => {
    const { w, tasks, owner, peopleUuid } = fixture();
    const task = w.createRow(tasks.id, { title: 'Ship it' });
    const stranger = w.createPage({ title: 'Somewhere else' });
    const sibling = w.createRow(tasks.id, { title: 'Another task' });
    for (const target of [w.getPage(stranger.id).uuid, w.getPage(sibling.id).uuid, peopleUuid]) {
      expect(() =>
        w.setPropertyValue(task.id, owner.id, { type: 'relation', value: [target] }),
      ).toThrow(rejectedWith('INVALID_VALUE'));
    }
  });

  it('clears the cell when the last target is removed', () => {
    const { w, tasks, owner, ada } = fixture();
    const task = w.createRow(tasks.id, { title: 'Ship it' });
    w.setPropertyValue(task.id, owner.id, {
      type: 'relation',
      value: [w.getPage(ada.id).uuid],
    });
    w.setPropertyValue(task.id, owner.id, { type: 'relation', value: [] });
    expect(w.getPage(task.id).properties?.[owner.id]).toBeUndefined();
    expect(storedProps(w, task.id)[owner.id]).toBeUndefined();
  });
});

describe('a target that is not there', () => {
  it('reads as gone and stays in the log', () => {
    const { w, tasks, owner, ada, grace } = fixture();
    const adaUuid = w.getPage(ada.id).uuid;
    const graceUuid = w.getPage(grace.id).uuid;
    const task = w.createRow(tasks.id, { title: 'Ship it' });
    w.setPropertyValue(task.id, owner.id, { type: 'relation', value: [adaUuid, graceUuid] });

    w.archivePage(ada.id);
    w.deletePage(ada.id);
    expect(w.getPage(task.id).properties?.[owner.id]).toEqual({
      type: 'relation',
      value: [graceUuid],
    });
    // Ignored on read, untouched in the log: the page could be on a device that has not
    // synced yet, and this reader has no way to tell that from one that never existed.
    expect(storedProps(w, task.id)[owner.id]).toEqual([adaUuid, graceUuid]);

    w.archivePage(grace.id);
    w.deletePage(grace.id);
    expect(w.getPage(task.id).properties?.[owner.id]).toBeUndefined();
    expect(storedProps(w, task.id)[owner.id]).toEqual([adaUuid, graceUuid]);
  });
});

describe('retyping', () => {
  it('hides a relation and gives it back, config and value intact', () => {
    const { w, tasks, owner, ada, peopleUuid } = fixture();
    const adaUuid = w.getPage(ada.id).uuid;
    const task = w.createRow(tasks.id, { title: 'Ship it' });
    w.setPropertyValue(task.id, owner.id, { type: 'relation', value: [adaUuid] });

    w.updateProperty(tasks.id, owner.id, { type: 'text' });
    expect(w.getPage(task.id).properties?.[owner.id]).toBeUndefined();

    w.updateProperty(tasks.id, owner.id, { type: 'relation' });
    const back = must(
      w.database(tasks.id).properties.find((p) => p.id === owner.id),
      'the property',
    );
    expect(back.config).toEqual({ database: peopleUuid });
    expect(w.getPage(task.id).properties?.[owner.id]).toEqual({
      type: 'relation',
      value: [adaUuid],
    });
  });

  it('can be pointed at a different database', () => {
    const { w, tasks, owner } = fixture();
    const places = w.createPage({ title: 'Places' });
    w.convertToDatabase(places.id);
    const placesUuid = w.getPage(places.id).uuid;
    const moved = w.updateProperty(tasks.id, owner.id, { config: { database: placesUuid } });
    expect(moved.config).toEqual({ database: placesUuid });
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
    return { ...origin, a, b, exchange };
  }

  const relationOf = (w: Workspace, rowId: NodeId, property: PropertyDef) =>
    w.getPage(rowId).properties?.[property.id];

  it('a relation defined on one device is usable on the other', () => {
    const { a, b, tasks, people, exchange } = pair();
    const peopleUuid = a.getPage(people.id).uuid;
    const lead = a.defineProperty(tasks.id, {
      name: 'Lead',
      type: 'relation',
      config: { database: peopleUuid },
    });
    const row = b.createRow(tasks.id, { title: 'Written on B' });
    exchange();

    const target = b.getPage(b.rows(people.id)[0]?.id ?? row.id).uuid;
    b.setPropertyValue(row.id, lead.id, { type: 'relation', value: [target] });
    exchange();
    expect(relationOf(a, row.id, lead)).toEqual({ type: 'relation', value: [target] });
    expect(relationOf(b, row.id, lead)).toEqual({ type: 'relation', value: [target] });
  });

  it('two devices adding a different target keep one side, and agree which', () => {
    const { a, b, tasks, owner, ada, grace, exchange } = pair();
    const adaUuid = a.getPage(ada.id).uuid;
    const graceUuid = a.getPage(grace.id).uuid;
    const task = a.createRow(tasks.id, { title: 'Ship it' });
    exchange();

    // A relation inherits multi-select's granularity: the whole array is one value, so
    // concurrent additions are a conflict rather than a union (ADR-0015). What matters
    // is that both devices end up saying the same thing.
    a.setPropertyValue(task.id, owner.id, { type: 'relation', value: [adaUuid] });
    b.setPropertyValue(task.id, owner.id, { type: 'relation', value: [graceUuid] });
    exchange();

    const onA = relationOf(a, task.id, owner);
    const onB = relationOf(b, task.id, owner);
    expect(onA).toEqual(onB);
    expect([[adaUuid], [graceUuid]]).toContainEqual((onA as { value: Uuid[] }).value);
  });

  it('a target only one device has yet is kept, and appears when it arrives', () => {
    const { a, b, people, tasks, owner, exchange } = pair();
    const task = a.createRow(tasks.id, { title: 'Ship it' });
    const newcomer = a.createRow(people.id, { title: 'Katherine' });
    const newcomerUuid = a.getPage(newcomer.id).uuid;
    a.setPropertyValue(task.id, owner.id, { type: 'relation', value: [newcomerUuid] });

    // B learns about the task and its value before it learns about the page they point
    // at. This is only reachable because the two arrive in separate exchanges; the value
    // must survive the gap rather than being scrubbed on read.
    b.merge(a.update());
    expect(relationOf(b, task.id, owner)).toEqual({ type: 'relation', value: [newcomerUuid] });
    exchange();
    expect(relationOf(b, task.id, owner)).toEqual({ type: 'relation', value: [newcomerUuid] });
  });
});
