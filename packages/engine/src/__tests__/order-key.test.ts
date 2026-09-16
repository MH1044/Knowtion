/**
 * Order keys, checked against the properties the two view interpreters rely on.
 *
 * The SQL side sorts with BINARY collation and the JS side with `<`; both are only right
 * if every generated key is ASCII and strictly between its neighbours, including after
 * jitter. A key that ended in `0` would leave a gap nothing could ever be inserted into,
 * and a key that could cross its upper neighbour would put a dragged row on the wrong side
 * of the row it was dropped against.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  JITTER_DIGITS,
  ORDER_KEY_DIGITS,
  compareOrderKeys,
  isOrderKey,
  orderKeyBetween,
  type OrderKey,
} from '../order-key.js';
import { deterministicRuntime, type Random } from '../runtime.js';

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

const random = (seed = 1): Random => deterministicRuntime(seed).random;

/** Printable seven-bit only: a key with anything else in it would sort differently in SQLite. */
const ASCII = /^[ -~]*$/;

/** A byte-wise comparison over UTF-8, standing in for SQLite's BINARY collation. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Build a sorted list of keys by a random sequence of insertions, which is the only way
 * to obtain arbitrary VALID keys: every key in the wild was made by this generator.
 */
function insertRandomly(steps: number[], seed = 1): OrderKey[] {
  const r = random(seed);
  const keys: OrderKey[] = [];
  for (const step of steps) {
    const index = keys.length === 0 ? 0 : step % (keys.length + 1);
    const key = orderKeyBetween(keys[index - 1], keys[index], r);
    keys.splice(index, 0, key);
  }
  return keys;
}

describe('the alphabet', () => {
  it('is 62 ASCII characters whose code order is their digit order', () => {
    expect(ORDER_KEY_DIGITS).toHaveLength(62);
    for (let i = 1; i < ORDER_KEY_DIGITS.length; i++) {
      expect(ORDER_KEY_DIGITS.charCodeAt(i)).toBeGreaterThan(ORDER_KEY_DIGITS.charCodeAt(i - 1));
    }
    expect(ASCII.test(ORDER_KEY_DIGITS)).toBe(true);
  });
});

describe('generating keys', () => {
  it('starts at a0 with jitter, and appends by stepping the integer part up', () => {
    const r = random();
    const first = orderKeyBetween(undefined, undefined, r);
    expect(first.startsWith('a0')).toBe(true);
    expect(first).toHaveLength(2 + JITTER_DIGITS);

    const second = orderKeyBetween(first, undefined, r);
    expect(compareOrderKeys(first, second)).toBe(-1);
    expect(second.startsWith('a1')).toBe(true);
  });

  it('prepends by stepping the integer part down, into the negatives', () => {
    const r = random();
    const first = orderKeyBetween(undefined, undefined, r);
    const before = orderKeyBetween(undefined, first, r);
    expect(compareOrderKeys(before, first)).toBe(-1);
    // Below a0 lies Zz: the largest one-digit negative.
    expect(before.startsWith('Zz')).toBe(true);
  });

  it('rejects neighbours that are out of order or malformed', () => {
    const r = random();
    expect(() => orderKeyBetween('a1', 'a0', r)).toThrow(/not below/);
    expect(() => orderKeyBetween('a0', 'a0', r)).toThrow(/not below/);
    expect(() => orderKeyBetween('a', undefined, r)).toThrow(/malformed/);
    expect(() => orderKeyBetween(undefined, 'a00', r)).toThrow(/malformed/); // trailing 0
    expect(() => orderKeyBetween('!0', undefined, r)).toThrow(/malformed/);
    expect(() => orderKeyBetween('a0é', undefined, r)).toThrow(/malformed/);
  });

  it('is deterministic from the seed, and different seeds differ', () => {
    const a = insertRandomly([0, 1, 1, 0, 2, 3, 1], 7);
    const b = insertRandomly([0, 1, 1, 0, 2, 3, 1], 7);
    const c = insertRandomly([0, 1, 1, 0, 2, 3, 1], 8);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });
});

describe('properties', () => {
  it('every generated key is valid, ASCII, never ends in 0, and lands strictly between', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000 }), { minLength: 1, maxLength: 60 }), (steps) => {
        const keys = insertRandomly(steps, 3);
        for (let i = 0; i < keys.length; i++) {
          const key = at(keys, i);
          expect(isOrderKey(key)).toBe(true);
          expect(key.endsWith('0')).toBe(false);
          expect(ASCII.test(key)).toBe(true);
          if (i > 0) expect(compareOrderKeys(at(keys, i - 1), key)).toBe(-1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('JavaScript comparison agrees with a byte-wise comparison, as SQLite BINARY would', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000 }), { minLength: 2, maxLength: 40 }), (steps) => {
        const keys = insertRandomly(steps, 5);
        for (let i = 1; i < keys.length; i++) {
          expect(Math.sign(byteCompare(at(keys, i - 1), at(keys, i)))).toBe(
            compareOrderKeys(at(keys, i - 1), at(keys, i)),
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a key between two neighbours is at most one character longer than the longer, plus jitter', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000 }), { minLength: 2, maxLength: 40 }), (steps) => {
        const keys = insertRandomly(steps, 11);
        const r = random(12);
        for (let i = 1; i < keys.length; i++) {
          const a = at(keys, i - 1);
          const b = at(keys, i);
          const between = orderKeyBetween(a, b, r);
          expect(between.length).toBeLessThanOrEqual(
            Math.max(a.length, b.length) + 1 + JITTER_DIGITS,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('growth', () => {
  it('ten thousand appends stay within six characters plus jitter', () => {
    const r = random(2);
    let last: OrderKey | undefined;
    for (let i = 0; i < 10_000; i++) last = orderKeyBetween(last, undefined, r);
    expect(last).toBeDefined();
    expect((last ?? '').length).toBeLessThanOrEqual(6 + JITTER_DIGITS);
  });

  it('ten thousand prepends are symmetric', () => {
    const r = random(2);
    let first: OrderKey | undefined;
    for (let i = 0; i < 10_000; i++) first = orderKeyBetween(undefined, first, r);
    expect((first ?? '').length).toBeLessThanOrEqual(6 + JITTER_DIGITS);
  });

  it('repeated insertion into the same gap grows linearly, not worse', () => {
    // The pathological case: always drop just after the first row. Each insert may add a
    // few characters; what must not happen is growth that compounds.
    const r = random(4);
    const a = orderKeyBetween(undefined, undefined, r);
    let b = orderKeyBetween(a, undefined, r);
    for (let i = 0; i < 200; i++) b = orderKeyBetween(a, b, r);
    expect(b.length).toBeLessThanOrEqual(3 * 200 + 2 + JITTER_DIGITS);
    expect(compareOrderKeys(a, b)).toBe(-1);
  });
});
