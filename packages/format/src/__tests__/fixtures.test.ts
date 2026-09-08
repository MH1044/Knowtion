/**
 * Golden-file compatibility tests.
 *
 * These fixtures are frozen bytes written by the build that shipped format version 0.
 * Every future build must still read them. This is the ONLY mechanism that catches an
 * accidental envelope change before it reaches a user's cloud folder, where — with no
 * backend and no forced upgrade — it could never be corrected.
 *
 * If a test here fails, the format changed. Do not regenerate the fixture. Either
 * revert the change or cut a new envelope version with its own fixture directory.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HEADER_SIZE,
  SUITE,
  crc32c,
  decodePack,
  isChainRoot,
  isShallowSnapshot,
} from '../index.js';

const fixturesV0 = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'v0');
const read = (name: string) => new Uint8Array(readFileSync(join(fixturesV0, `${name}.kpack`)));

/** Byte-exact identity of each fixture. Changing a number here defeats the test. */
const EXPECTED = {
  'empty-payload': { size: 180, crc: 0x48674bc7 },
  'chain-root': { size: 211, crc: 0x18f3630d },
  chained: { size: 191, crc: 0x38fdaeed },
  'shallow-snapshot': { size: 194, crc: 0xe333c61f },
  'crypto-fields-populated': { size: 198, crc: 0xd5e58e56 },
} as const;

describe('format v0 golden fixtures', () => {
  it('the fixture directory contains exactly the files we assert on', () => {
    // Guards against a fixture being added or deleted without updating this suite.
    const onDisk = readdirSync(fixturesV0)
      .filter((f) => f.endsWith('.kpack'))
      .map((f) => f.replace(/\.kpack$/, ''))
      .sort();
    expect(onDisk).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s is byte-identical to when it was frozen', (name, exp) => {
    const bytes = read(name);
    expect(bytes.length).toBe(exp.size);
    expect(crc32c(bytes)).toBe(exp.crc);
  });

  it.each(Object.keys(EXPECTED))('%s still decodes without error', (name) => {
    expect(() => decodePack(read(name), `${name}.kpack`)).not.toThrow();
  });

  it('empty-payload is exactly one header and nothing more', () => {
    const { header, payload } = decodePack(read('empty-payload'));
    expect(read('empty-payload')).toHaveLength(HEADER_SIZE);
    expect(header.payloadLen).toBe(0);
    expect(payload).toHaveLength(0);
    expect(isChainRoot(header)).toBe(true);
  });

  it('chain-root carries a plaintext payload with no crypto fields set', () => {
    const { header, payload } = decodePack(read('chain-root'));
    expect(header.envelopeVersion).toBe(0);
    expect(header.suiteId).toBe(SUITE.NONE);
    expect(header.seq).toBe(1n);
    expect(header.keyEpoch).toBe(0);
    expect(isChainRoot(header)).toBe(true);
    expect(new TextDecoder().decode(payload)).toBe('knowtion golden fixture payload');
  });

  it('chained records its predecessor, so a gap in the chain is detectable', () => {
    const { header } = decodePack(read('chained'));
    expect(header.seq).toBe(42n);
    expect(isChainRoot(header)).toBe(false);
    expect(Array.from(header.prevPackHash.subarray(0, 4))).toEqual([0, 1, 2, 3]);
  });

  it('shallow-snapshot sets the snapshot flag', () => {
    const { header } = decodePack(read('shallow-snapshot'));
    expect(isShallowSnapshot(header)).toBe(true);
    expect(header.seq).toBe(100n);
  });

  it('crypto-fields-populated proves v0 already carries every encryption field', () => {
    // The reason v0.2 needs no migration: the space was always reserved and readable.
    const { header } = decodePack(read('crypto-fields-populated'));
    expect(header.suiteId).toBe(SUITE.XCHACHA20POLY1305_ARGON2ID);
    expect(header.keyEpoch).toBe(3);
    expect(header.paddingLen).toBe(5);
    expect(header.seq).toBe(0xffff_ffff_ffff_ffffn);
    expect(header.packSalt.every((b) => b === 0)).toBe(false);
    expect(header.deviceSignature.every((b) => b === 0)).toBe(false);
  });
});
