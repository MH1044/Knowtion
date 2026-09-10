import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bytesToUuid, createIdGen, uuidToBytes, uuidTimestamp } from '../ids.js';
import { deterministicRuntime, systemRuntime } from '../runtime.js';

/** Indexing a Uint8Array can't statically prove the index is in bounds. */
function at(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

describe('UUIDv7', () => {
  it('has the version and variant bits RFC 9562 requires', () => {
    const gen = createIdGen(deterministicRuntime(1));
    for (let i = 0; i < 200; i++) {
      const b = gen.nextBytes();
      expect(at(b, 6) >>> 4, 'version nibble').toBe(0x7);
      expect(at(b, 8) >>> 6, 'variant bits').toBe(0b10);
    }
  });

  it('is canonical lowercase hyphenated text', () => {
    const gen = createIdGen(deterministicRuntime(2));
    for (let i = 0; i < 50; i++) {
      expect(gen.next()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('sorts in creation order even within a single millisecond', () => {
    // The whole reason for the monotonic counter. A frozen clock is the worst case:
    // 200 blocks pasted in one tick must keep their relative order.
    const frozen = {
      clock: { now: () => 1_700_000_000_000 },
      random: deterministicRuntime(3).random,
    };
    const gen = createIdGen(frozen);
    const ids = Array.from({ length: 500 }, () => gen.next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });

  it('stays monotonic when the system clock jumps backwards', () => {
    // Devices travel across timezones and users set clocks by hand. An identifier that
    // sorts into the past corrupts ordering everywhere it is used as a tiebreak.
    let t = 1_700_000_000_000;
    const jumpy = {
      clock: { now: () => (t -= 1000) },
      random: deterministicRuntime(4).random,
    };
    const gen = createIdGen(jumpy);
    const ids = Array.from({ length: 100 }, () => gen.next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('survives counter exhaustion inside one millisecond without repeating', () => {
    // The counter is 12 bits. Generating more than 4096 in a frozen millisecond must
    // borrow from the next millisecond rather than wrap and collide.
    const frozen = {
      clock: { now: () => 1_700_000_000_000 },
      random: deterministicRuntime(5).random,
    };
    const gen = createIdGen(frozen);
    const ids = Array.from({ length: 9000 }, () => gen.next());
    expect(new Set(ids).size).toBe(9000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('is reproducible from a seed, which is what makes the simulator possible', () => {
    const a = Array.from(
      { length: 20 },
      (
        (g) => () =>
          g.next()
      )(createIdGen(deterministicRuntime(42))),
    );
    const b = Array.from(
      { length: 20 },
      (
        (g) => () =>
          g.next()
      )(createIdGen(deterministicRuntime(42))),
    );
    expect(a).toEqual(b);

    const c = Array.from(
      { length: 20 },
      (
        (g) => () =>
          g.next()
      )(createIdGen(deterministicRuntime(43))),
    );
    expect(c).not.toEqual(a);
  });

  it('produces distinct values under the real runtime', () => {
    const gen = createIdGen(systemRuntime());
    const ids = Array.from({ length: 5000 }, () => gen.next());
    expect(new Set(ids).size).toBe(5000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('round-trips between text and bytes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const gen = createIdGen(deterministicRuntime(seed));
        const bytes = gen.nextBytes();
        expect(uuidToBytes(bytesToUuid(bytes))).toEqual(bytes);
      }),
      { numRuns: 300 },
    );
  });

  it('exposes the embedded timestamp, and it tracks the clock', () => {
    const gen = createIdGen(deterministicRuntime(7, 1_700_000_000_000));
    const first = uuidTimestamp(gen.next());
    for (let i = 0; i < 10; i++) gen.next();
    expect(uuidTimestamp(gen.next())).toBeGreaterThan(first);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => uuidToBytes('not-a-uuid')).toThrow(TypeError);
    expect(() => uuidToBytes('0198A1B2-C3D4-7000-8000-000000000000')).toThrow(TypeError);
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow(TypeError);
  });
});
