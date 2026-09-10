import { LoroDoc } from 'loro-crdt';
import { generateDeviceKeys, toHex, type DeviceRecord } from '@knowtion/format';
import { describe, expect, it } from 'vitest';

import { DeviceRegistry } from '../device-registry.js';
import { DeviceEviction, detectEvicted } from '../eviction.js';
import { MemoryStorage } from '../memory-storage.js';
import { PackStore } from '../pack-store.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const A = new Uint8Array(16).fill(0xaa);
const B = new Uint8Array(16).fill(0xbb);
const hexA = toHex(A);
const hexB = toHex(B);

function clock(start = 1_700_000_000_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

async function deviceWithHistory(storage: MemoryStorage, id: Uint8Array, packs: number) {
  const doc = new LoroDoc();
  doc.setPeerId(BigInt(id[0]!));
  const store = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: id });
  for (let i = 0; i < packs; i++) {
    doc.getMap('notes').set(`${toHex(id).slice(0, 4)}-${i}`, i);
    doc.commit();
    await store.push(doc);
  }
  return { doc, store };
}

async function enrol(storage: MemoryStorage, id: Uint8Array, label: string) {
  const keys = generateDeviceKeys();
  const record: DeviceRecord = {
    deviceId: id,
    workspaceId: WORKSPACE,
    signingPublicKey: keys.signingPublicKey,
    wrappingPublicKey: keys.wrappingPublicKey,
    label,
    enrolledAt: 1,
  };
  await new DeviceRegistry(storage).enrol(record, keys.signingSecretKey);
}

describe('forgetting a device', () => {
  it('removes its record first, so it stops holding the trim floor open', async () => {
    // Until the record is gone the device still counts as registered, and compaction
    // still refuses to trim anything — which is the whole reason for forgetting it.
    const storage = new MemoryStorage();
    await enrol(storage, A, 'Keeper');
    await enrol(storage, B, 'Lost laptop');
    await deviceWithHistory(storage, B, 3);

    const eviction = new DeviceEviction({ storage, actingDeviceHex: hexA, now: clock().now });
    await eviction.forget(hexB);

    const registry = await new DeviceRegistry(storage).list();
    expect(registry.devices.map((d) => d.label)).toEqual(['Keeper']);
  });

  it('removes its packs, drip-fed rather than all at once', async () => {
    const storage = new MemoryStorage();
    const time = clock();
    await enrol(storage, B, 'Lost laptop');
    await deviceWithHistory(storage, B, 12);

    const eviction = new DeviceEviction({
      storage,
      actingDeviceHex: hexA,
      now: time.now,
      deletesPerHour: 4,
    });

    const first = await eviction.forget(hexB);
    expect(first.deleted).toBe(4);
    expect(first.done).toBe(false);

    // The budget is a rolling hour; waiting minutes does not refresh it.
    time.advance(5 * 60 * 1000);
    expect((await eviction.forget(hexB)).deleted).toBe(0);

    for (let hour = 0; hour < 6; hour++) {
      time.advance(61 * 60 * 1000);
      await eviction.forget(hexB);
    }
    expect((await storage.list(`d/${hexB}/`)).length).toBe(0);
  });

  it('leaves every other device untouched', async () => {
    const storage = new MemoryStorage();
    await deviceWithHistory(storage, A, 3);
    await deviceWithHistory(storage, B, 3);

    const eviction = new DeviceEviction({
      storage,
      actingDeviceHex: hexA,
      now: clock().now,
      deletesPerHour: 100,
    });
    await eviction.forget(hexB);

    expect((await storage.list(`d/${hexA}/`)).length).toBeGreaterThan(0);
    expect((await storage.list(`d/${hexB}/`)).length).toBe(0);
  });

  it('refuses to let a device forget itself', async () => {
    const eviction = new DeviceEviction({
      storage: new MemoryStorage(),
      actingDeviceHex: hexA,
      now: clock().now,
    });
    await expect(eviction.forget(hexA)).rejects.toThrow(/cannot forget itself/);
  });

  it('reports done when there is nothing left to remove', async () => {
    const eviction = new DeviceEviction({
      storage: new MemoryStorage(),
      actingDeviceHex: hexA,
      now: clock().now,
    });
    expect(await eviction.forget(hexB)).toEqual({ deleted: 0, remaining: 0, done: true });
  });
});

describe('noticing that we have been evicted', () => {
  it('says nothing about a device that has never published', async () => {
    expect(await detectEvicted(new MemoryStorage(), A, 0)).toBe(false);
  });

  it('is false while our packs are present', async () => {
    const storage = new MemoryStorage();
    await deviceWithHistory(storage, A, 3);
    expect(await detectEvicted(storage, A, 3)).toBe(false);
  });

  it('is true once another device has forgotten us', async () => {
    // Our own packs are immutable and only we delete them, so their absence cannot
    // arise from ordinary operation — it means someone removed us.
    const storage = new MemoryStorage();
    await deviceWithHistory(storage, A, 3);

    const eviction = new DeviceEviction({
      storage,
      actingDeviceHex: hexB,
      now: clock().now,
      deletesPerHour: 100,
    });
    await eviction.forget(hexA);

    expect(await detectEvicted(storage, A, 3)).toBe(true);
  });
});

describe('a forgotten device that comes back', () => {
  it('republishes its whole history under a fresh identity', async () => {
    // Its own notes were never at risk: they live in its local document. What it lost
    // is its place in the folder, and the recovery is to rejoin as a new device rather
    // than resume a chain other devices have already discarded.
    const storage = new MemoryStorage();
    const time = clock();

    const returning = await deviceWithHistory(storage, A, 4);
    returning.doc.getMap('notes').set('written before eviction', 'still here');
    returning.doc.commit();
    await returning.store.push(returning.doc);

    // Another device gives up on it.
    await new DeviceEviction({
      storage,
      actingDeviceHex: hexB,
      now: time.now,
      deletesPerHour: 100,
    }).forget(hexA);

    expect(await detectEvicted(storage, A, 5)).toBe(true);

    // It rejoins under a new identifier. Reusing the old one would be worse than
    // useless: other devices remember those sequence numbers and would skip the new
    // packs as ones they had already seen.
    const rejoinedId = new Uint8Array(16).fill(0xcc);
    const rejoined = new PackStore({
      storage,
      workspaceId: WORKSPACE,
      deviceId: rejoinedId,
    });
    await rejoined.push(returning.doc);

    // A device that never knew the original picks the content up in full.
    const observer = new LoroDoc();
    observer.setPeerId(99n);
    const observerStore = new PackStore({
      storage,
      workspaceId: WORKSPACE,
      deviceId: new Uint8Array(16).fill(0xdd),
    });
    const result = await observerStore.pull(observer);

    expect(result.rejected).toEqual([]);
    expect(observer.getMap('notes').toJSON()).toEqual(returning.doc.getMap('notes').toJSON());
    expect(JSON.stringify(observer.getMap('notes').toJSON())).toContain('still here');
  });

  it('keeps its own notes throughout, since eviction only touches the folder', async () => {
    const storage = new MemoryStorage();
    const returning = await deviceWithHistory(storage, A, 3);
    const before = returning.doc.getMap('notes').toJSON();

    await new DeviceEviction({
      storage,
      actingDeviceHex: hexB,
      now: clock().now,
      deletesPerHour: 100,
    }).forget(hexA);

    expect(returning.doc.getMap('notes').toJSON()).toEqual(before);
  });
});
