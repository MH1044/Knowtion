/**
 * The restart path, pinned on its own before the crash gate leans on it.
 *
 * A restart that quietly kept anything in memory would let the gate pass without the
 * recovery path working, so each of these checks that a specific thing was really lost
 * and really rebuilt from the log.
 */
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '@knowtion/sync';

import { SimulatedDevice } from '../device.js';
import { seededRandom } from '../deterministic.js';
import { shape } from '../simulator.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);

function device(storage: MemoryStorage, seed = 3, deviceByte = 0xa0): SimulatedDevice {
  return new SimulatedDevice({
    name: 'd',
    storage,
    workspaceId: WORKSPACE,
    deviceId: new Uint8Array(16).fill(deviceByte),
    peerId: BigInt(deviceByte),
    seed,
  });
}

describe('SimulatedDevice.restart', () => {
  it('rebuilds exactly what was pushed, from storage alone', async () => {
    const storage = new MemoryStorage();
    const d = device(storage);
    const random = seededRandom(1);
    for (let i = 0; i < 12; i++) d.act(random, i % 3 === 0 ? 'createPage' : 'createChild');
    d.act(random, 'renamePage');
    const before = shape(d);
    expect(await d.push()).toMatchObject({ kind: 'pushed' });

    d.restart();
    expect(d.boots).toBe(1);
    expect(d.workspace.allPages()).toEqual([]); // genuinely empty until the pull
    expect(d.lastSeq).toBe(0);

    const pulled = await d.pull();
    expect(pulled?.rejected).toEqual([]);
    expect(shape(d)).toEqual(before);
    expect(d.lastSeq).toBe(1);
    d.close();
  });

  it('drops edits that were never pushed, which is the honest outcome of a kill', async () => {
    const storage = new MemoryStorage();
    const d = device(storage);
    const random = seededRandom(2);
    d.act(random, 'createPage');
    await d.push();
    const committed = shape(d);

    d.act(random, 'createPage');
    d.act(random, 'createPage');
    expect(shape(d)).toHaveLength(3);

    d.restart();
    await d.pull();
    expect(shape(d)).toEqual(committed);
    d.close();
  });

  it('mints fresh identifiers after a restart rather than replaying the seed', async () => {
    const storage = new MemoryStorage();
    const d = device(storage);
    const random = seededRandom(3);
    d.act(random, 'createPage');
    d.act(random, 'createPage');
    // The UUIDv7, not the Loro tree id: the tree id is peer-and-counter and would differ
    // regardless, whereas the UUID is what the seeded clock and PRNG actually mint.
    const firstBoot = d.workspace.allPages().map((p) => p.uuid);
    await d.push();

    d.restart();
    await d.pull();
    d.act(random, 'createPage');
    d.act(random, 'createPage');
    const uuids = d.workspace.allPages().map((p) => p.uuid);

    // Four distinct pages, and the two new ones are not the two old ones under new names.
    expect(new Set(uuids).size).toBe(4);
    const minted = uuids.filter((id) => !firstBoot.includes(id));
    expect(minted).toHaveLength(2);
    // UUIDv7 sorts by time, and the second boot's clock starts later.
    for (const id of minted) for (const old of firstBoot) expect(id > old).toBe(true);
    d.close();
  });

  it('continues its own chain after restarting', async () => {
    const storage = new MemoryStorage();
    const d = device(storage);
    const random = seededRandom(4);
    d.act(random, 'createPage');
    await d.push();
    d.restart();
    await d.pull();
    d.act(random, 'createPage');
    const outcome = await d.push();
    expect(outcome).toMatchObject({ kind: 'pushed', result: { seq: 2 } });

    // A stranger reads the whole thing back with no rejections.
    const reader = device(storage, 99, 0xc0);
    const result = await reader.pull();
    expect(result?.rejected).toEqual([]);
    expect(shape(reader)).toEqual(shape(d));
    d.close();
    reader.close();
  });

  it('reports idle, pushed and failed as different outcomes', async () => {
    const storage = new MemoryStorage();
    const d = device(storage);
    expect(await d.push()).toEqual({ kind: 'idle' });
    d.act(seededRandom(5), 'createPage');
    expect(await d.push()).toMatchObject({ kind: 'pushed' });
    d.online = false;
    d.act(seededRandom(6), 'createPage');
    expect(await d.push()).toEqual({ kind: 'idle' });
    d.close();
  });
});
