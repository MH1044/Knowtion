import { describe, expect, it } from 'vitest';
import { crc32c } from '../crc32c.js';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('crc32c', () => {
  // The standard check value for CRC-32C, from the algorithm's specification.
  it('matches the standard check vector for "123456789"', () => {
    expect(crc32c(ascii('123456789'))).toBe(0xe3069283);
  });

  it('returns 0 for empty input', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  it('is stable across calls, so the lazy table is not corrupted by use', () => {
    const first = crc32c(ascii('knowtion'));
    for (let i = 0; i < 100; i++) crc32c(ascii(`noise-${i}`));
    expect(crc32c(ascii('knowtion'))).toBe(first);
  });

  it('detects a single bit flip anywhere in a header-sized buffer', () => {
    const buf = new Uint8Array(180).fill(0xa5);
    const base = crc32c(buf);
    for (let byte = 0; byte < buf.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const flipped = Uint8Array.from(buf);
        flipped[byte]! ^= 1 << bit;
        expect(crc32c(flipped), `byte ${byte} bit ${bit}`).not.toBe(base);
      }
    }
  });

  it('always returns an unsigned 32-bit value', () => {
    for (let i = 0; i < 200; i++) {
      const v = crc32c(ascii(`sample ${i}`));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
