import { describe, expect, it } from 'vitest';
import { equalBytes, hash, keyedHash, toHex } from '../hash.js';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('BLAKE3', () => {
  it('matches the official empty-input vector', () => {
    // Pinning the library against the specification, not against itself.
    expect(toHex(hash(new Uint8Array(0)))).toBe(
      'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    );
  });

  it('produces exactly 32 bytes, as FORMAT.md requires', () => {
    expect(hash(ascii('knowtion'))).toHaveLength(32);
  });

  it('is deterministic and sensitive to a single bit', () => {
    expect(toHex(hash(ascii('a')))).toBe(toHex(hash(ascii('a'))));
    expect(toHex(hash(ascii('a')))).not.toBe(toHex(hash(ascii('b'))));
  });

  it('keyed hashing differs from plain hashing of the same bytes', () => {
    // The property attachment addressing depends on: without the key, anyone with the
    // cloud layout could confirm a known file is present.
    const key = new Uint8Array(32).fill(7);
    expect(toHex(keyedHash(key, ascii('secret.pdf')))).not.toBe(toHex(hash(ascii('secret.pdf'))));
  });

  it('keyed hashing differs per key, so workspaces cannot be correlated', () => {
    const a = keyedHash(new Uint8Array(32).fill(1), ascii('same file'));
    const b = keyedHash(new Uint8Array(32).fill(2), ascii('same file'));
    expect(equalBytes(a, b)).toBe(false);
  });

  it('rejects a key of the wrong length rather than silently padding it', () => {
    expect(() => keyedHash(new Uint8Array(16), ascii('x'))).toThrow(TypeError);
  });

  it('renders lowercase hex only', () => {
    expect(toHex(Uint8Array.from([0x00, 0x0f, 0xff]))).toBe('000fff');
  });

  it('compares bytes without short-circuiting on length alone', () => {
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(equalBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(equalBytes(Uint8Array.from([1]), Uint8Array.from([1, 2]))).toBe(false);
  });
});
