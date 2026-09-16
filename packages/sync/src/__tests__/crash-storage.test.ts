/**
 * The crash decorator, checked against the two properties the soak leans on.
 *
 * If a crash did not latch, the flush continuation would keep writing after "the process
 * died" and every result the soak reported would describe a machine that cannot exist.
 * If a torn write were ever the full object, the torn mode would silently become the
 * after-write mode and the wedge it exists to provoke would never be provoked.
 */
import { describe, expect, it } from 'vitest';

import { CrashStorage, ProcessCrashedError } from '../crash-storage.js';
import { MemoryStorage } from '../memory-storage.js';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

/** A fixed sequence, so each test states exactly which prefix branch it exercises. */
function draws(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v ?? 0;
  };
}

describe('CrashStorage', () => {
  it('passes every call through while nothing is armed', async () => {
    const inner = new MemoryStorage();
    const storage = new CrashStorage({ inner, random: () => 0.5 });

    expect(await storage.putIfAbsent('a', bytes(3))).toBe(true);
    expect(await storage.putIfAbsent('a', bytes(3))).toBe(false);
    expect(await storage.get('a')).toEqual(bytes(3));
    expect((await storage.list('')).map((o) => o.path)).toEqual(['a']);
    await storage.putOwn('b', bytes(1));
    await storage.delete('a');
    expect(await storage.get('a')).toBeUndefined();
    expect(storage.crashed).toBe(false);
  });

  it('a torn write leaves a strict prefix on the disk and throws', async () => {
    const inner = new MemoryStorage();
    // 0.9 selects the in-payload branch; the second draw places the cut.
    const storage = new CrashStorage({ inner, random: draws([0.9, 0.5]) });
    storage.arm('torn-write');

    await expect(storage.putIfAbsent('p', bytes(400))).rejects.toBeInstanceOf(ProcessCrashedError);

    const left = await inner.get('p');
    expect(left).toBeDefined();
    expect(left?.length).toBeGreaterThanOrEqual(180);
    expect(left?.length).toBeLessThan(400);
    expect(left).toEqual(bytes(400).subarray(0, left?.length));
    expect(storage.stats.tornWrites).toBe(1);
    expect(storage.stats.tornPrefixes).toEqual([left?.length]);
  });

  it('covers a zero-byte file and a cut inside the header', async () => {
    const zero = new CrashStorage({ inner: new MemoryStorage(), random: draws([0.1]) });
    zero.arm('torn-write');
    await expect(zero.putIfAbsent('p', bytes(400))).rejects.toThrow();
    expect(zero.stats.tornPrefixes).toEqual([0]);

    const header = new CrashStorage({ inner: new MemoryStorage(), random: draws([0.3, 0.5]) });
    header.arm('torn-write');
    await expect(header.putIfAbsent('p', bytes(400))).rejects.toThrow();
    const kept = header.stats.tornPrefixes[0] ?? -1;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(180);
  });

  it('an after-write crash persists the whole object but still throws', async () => {
    const inner = new MemoryStorage();
    const storage = new CrashStorage({ inner, random: () => 0.5 });
    storage.arm('after-write');

    await expect(storage.putIfAbsent('p', bytes(50))).rejects.toBeInstanceOf(ProcessCrashedError);
    expect(await inner.get('p')).toEqual(bytes(50));
    expect(storage.stats.afterWrites).toBe(1);
  });

  it('latches: after a crash every call throws until reboot', async () => {
    const inner = new MemoryStorage();
    const storage = new CrashStorage({ inner, random: () => 0.5 });
    storage.arm('after-write');
    await expect(storage.putIfAbsent('p', bytes(5))).rejects.toThrow();
    expect(storage.crashed).toBe(true);

    // The dead process cannot do anything, including the head.json write that would
    // otherwise follow the pack, and including reads.
    await expect(storage.putOwn('head', bytes(1))).rejects.toBeInstanceOf(ProcessCrashedError);
    await expect(storage.get('p')).rejects.toBeInstanceOf(ProcessCrashedError);
    await expect(storage.list('')).rejects.toBeInstanceOf(ProcessCrashedError);
    await expect(storage.delete('p')).rejects.toBeInstanceOf(ProcessCrashedError);
    await expect(storage.putIfAbsent('q', bytes(1))).rejects.toBeInstanceOf(ProcessCrashedError);
    expect(await inner.get('head')).toBeUndefined();

    storage.reboot();
    expect(storage.crashed).toBe(false);
    expect(storage.armed).toBeUndefined();
    expect(await storage.get('p')).toEqual(bytes(5));
  });

  it('arming is consumed by the write it interrupts, not carried to the next', async () => {
    const storage = new CrashStorage({ inner: new MemoryStorage(), random: () => 0.5 });
    storage.arm('after-write');
    expect(storage.armed).toBe('after-write');
    await expect(storage.putIfAbsent('p', bytes(5))).rejects.toThrow();
    storage.reboot();
    expect(await storage.putIfAbsent('q', bytes(5))).toBe(true);
    expect(storage.stats.afterWrites).toBe(1);
  });
});
