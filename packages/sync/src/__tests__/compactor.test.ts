import { LoroDoc, VersionVector } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import { Compactor } from '../compactor.js';
import { MemoryStorage } from '../memory-storage.js';
import { PackStore, packPath } from '../pack-store.js';
import { computeTrimFloor } from '../trim-floor.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const DEVICE = new Uint8Array(16).fill(0xaa);
const HEX = 'aa'.repeat(16);
const TREE = '0'.repeat(32);
const DAY = 24 * 60 * 60 * 1000;

/** Unwraps a lookup/computation the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** A clock the test drives, so a ninety-day grace period takes no time at all. */
function clock(start = 1_700_000_000_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

async function workspaceWithPacks(storage: MemoryStorage, packs: number) {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  const store = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE });
  for (let i = 0; i < packs; i++) {
    doc.getMap('notes').set(`k${String(i)}`, i);
    doc.commit();
    await store.push(doc);
  }
  return { doc, store };
}

/** A floor at everything this document currently holds. */
function floorAt(doc: LoroDoc) {
  const merged = Buffer.from(doc.version().encode()).toString('hex');
  return must(
    computeTrimFloor({
      registeredDevices: [HEX],
      acks: new Map([[HEX, { mergedVersion: merged, updatedAt: 1 }]]),
    }),
    'a trim floor',
  );
}

function compactorFor(storage: MemoryStorage, time: ReturnType<typeof clock>, policy = {}) {
  return new Compactor({
    storage,
    workspaceId: WORKSPACE,
    deviceId: DEVICE,
    deviceHex: HEX,
    documentHex: TREE,
    now: time.now,
    policy,
  });
}

describe('publishing a snapshot', () => {
  it('writes it under our own prefix and deletes nothing', async () => {
    // The single-writer rule: the packs below a floor mostly belong to other devices,
    // and reaching into their namespace would break the invariant the layout rests on.
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 4);
    const before = (await storage.list('d/')).length;

    const record = await compactorFor(storage, time).writeSnapshot(doc, floorAt(doc), 4);

    expect(record?.seq).toBe(4);
    const after = await storage.list('d/');
    expect(after.length).toBeGreaterThan(before); // added, never removed
    expect(after.some((o) => o.path.includes('/snap/'))).toBe(true);
    expect(await storage.get(packPath(HEX, TREE, 1))).toBeDefined();
  });

  it('does not publish a second snapshot when nothing has changed', async () => {
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 3);
    const compactor = compactorFor(storage, time);

    expect(await compactor.writeSnapshot(doc, floorAt(doc), 3)).toBeDefined();
    expect(await compactor.writeSnapshot(doc, floorAt(doc), 3)).toBeUndefined();
  });

  it('declines a floor this document cannot be trimmed to', async () => {
    // A floor naming operations this device has never seen is not an error to report,
    // it is a reason to keep everything.
    const storage = new MemoryStorage();
    const { doc } = await workspaceWithPacks(storage, 2);
    const unknownPeer = new VersionVector(new Map([['999', 50]]));

    const record = await compactorFor(storage, clock()).writeSnapshot(
      doc,
      { version: unknownPeer, counters: new Map([['999', 50]]) },
      2,
    );
    expect(record).toBeUndefined();
  });

  it('produces a snapshot a fresh device can load on its own', async () => {
    const storage = new MemoryStorage();
    const { doc } = await workspaceWithPacks(storage, 5);
    await compactorFor(storage, clock()).writeSnapshot(doc, floorAt(doc), 5);

    const snapshotPath = must(
      (await storage.list('d/')).find((o) => o.path.includes('/snap/')),
      'a snapshot object',
    ).path;
    const bytes = must(await storage.get(snapshotPath), 'the snapshot bytes');
    // The payload sits inside a normal envelope, 180 bytes in.
    const reloaded = new LoroDoc();
    reloaded.import(bytes.slice(180));
    expect(reloaded.getMap('notes').toJSON()).toEqual(doc.getMap('notes').toJSON());
  });
});

describe('the grace period', () => {
  it('deletes nothing until a snapshot has matured', async () => {
    // The version vector already proves every device HAS the operations. The grace
    // period is for the case where that proof is wrong, and gives a person time to
    // notice before anything is gone.
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 4);
    const compactor = compactorFor(storage, time);
    await compactor.writeSnapshot(doc, floorAt(doc), 4);

    const early = await compactor.collect();
    expect(early.deleted).toBe(0);
    expect(early.reason).toMatch(/grace period/);
    expect(await storage.get(packPath(HEX, TREE, 1))).toBeDefined();

    time.advance(89 * DAY);
    expect((await compactor.collect()).deleted).toBe(0);

    time.advance(2 * DAY);
    expect((await compactor.collect()).deleted).toBeGreaterThan(0);
  });

  it('deletes only packs the snapshot supersedes', async () => {
    const storage = new MemoryStorage();
    const time = clock();
    const { doc, store } = await workspaceWithPacks(storage, 3);
    const compactor = compactorFor(storage, time);
    await compactor.writeSnapshot(doc, floorAt(doc), 3);

    // Work written after the snapshot must survive it.
    doc.getMap('notes').set('after', 'the snapshot');
    doc.commit();
    await store.push(doc);

    time.advance(100 * DAY);
    await compactor.collect();

    expect(await storage.get(packPath(HEX, TREE, 1))).toBeUndefined();
    expect(await storage.get(packPath(HEX, TREE, 4)), 'later work survives').toBeDefined();
  });

  it('never touches another device prefix', async () => {
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 3);

    const otherHex = 'bb'.repeat(16);
    await storage.putIfAbsent(packPath(otherHex, TREE, 1), new Uint8Array(200));

    const compactor = compactorFor(storage, time);
    await compactor.writeSnapshot(doc, floorAt(doc), 3);
    time.advance(100 * DAY);
    await compactor.collect();

    expect(await storage.get(packPath(otherHex, TREE, 1)), 'not ours to delete').toBeDefined();
  });
});

describe('the deletion rate limit', () => {
  it('drips deletions out rather than emptying the folder at once', async () => {
    // OneDrive's ransomware detection has no documented threshold and no opt-out, and
    // its remedy is a point-in-time restore that would roll the log backwards — turning
    // a tidy-up into the data loss compaction exists to prevent.
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 30);
    const compactor = compactorFor(storage, time, { deletesPerHour: 5 });
    await compactor.writeSnapshot(doc, floorAt(doc), 30);
    time.advance(100 * DAY);

    const first = await compactor.collect();
    expect(first.deleted).toBe(5);
    expect(first.withheld).toBeGreaterThan(0);

    // Waiting a few minutes must not launder the budget.
    time.advance(10 * 60 * 1000);
    expect((await compactor.collect()).deleted).toBe(0);

    time.advance(61 * 60 * 1000);
    expect((await compactor.collect()).deleted).toBe(5);
  });

  it('eventually removes everything superseded, given enough time', async () => {
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 12);
    const compactor = compactorFor(storage, time, { deletesPerHour: 5 });
    await compactor.writeSnapshot(doc, floorAt(doc), 12);
    time.advance(100 * DAY);

    for (let hour = 0; hour < 6; hour++) {
      await compactor.collect();
      time.advance(61 * 60 * 1000);
    }

    const remaining = (await storage.list(`d/${HEX}/${TREE}/`)).filter((o) =>
      o.path.endsWith('.kpack'),
    );
    expect(remaining).toEqual([]);
  });

  it('survives a lost compaction record by keeping everything', async () => {
    // Losing it costs a grace period, never data: with no record, nothing is mature.
    const storage = new MemoryStorage();
    const time = clock();
    const { doc } = await workspaceWithPacks(storage, 4);
    const compactor = compactorFor(storage, time);
    await compactor.writeSnapshot(doc, floorAt(doc), 4);
    time.advance(100 * DAY);

    await storage.putOwn(
      `d/${HEX}/${TREE}/compaction.json`,
      new TextEncoder().encode('{ truncated'),
    );

    const result = await compactor.collect();
    expect(result.deleted).toBe(0);
    expect(await storage.get(packPath(HEX, TREE, 1))).toBeDefined();
  });
});
