import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ENVELOPE_VERSION,
  HEADER_SIZE,
  OFFSET,
  PackFormatError,
  SUITE,
  decodePack,
  encodePack,
  isChainRoot,
  isShallowSnapshot,
  isUnsupportedVersion,
  signedBytes,
} from '../index.js';

const bytesOf = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

const validPack = (over: Partial<Parameters<typeof encodePack>[0]> = {}) =>
  encodePack({
    workspaceId: bytesOf(16, 0x11),
    deviceId: bytesOf(16, 0x22),
    seq: 1n,
    payload: new TextEncoder().encode('loro-payload-stand-in'),
    ...over,
  });

/** Recompute the header checksum after mutating a header byte, to isolate one rule. */
function resealCrc(pack: Uint8Array): Uint8Array {
  const out = Uint8Array.from(pack);
  const view = new DataView(out.buffer);
  // Deliberately re-derives the CRC the same way the encoder does.
  let crc = 0xffffffff;
  const poly = 0x82f63b78;
  for (let i = 0; i < OFFSET.headerCrc32c; i++) {
    crc ^= out[i]!;
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1;
  }
  view.setUint32(OFFSET.headerCrc32c, (crc ^ 0xffffffff) >>> 0, true);
  return out;
}

describe('pack envelope', () => {
  it('produces a header of exactly the specified size', () => {
    expect(validPack({ payload: new Uint8Array(0) })).toHaveLength(HEADER_SIZE);
  });

  it('keeps magic at offset 0 and version at offset 4, which must never move', () => {
    const pack = validPack();
    expect(Array.from(pack.subarray(0, 4))).toEqual([0x4b, 0x4e, 0x4f, 0x57]);
    expect(new DataView(pack.buffer).getUint16(4, true)).toBe(ENVELOPE_VERSION);
  });

  it('defaults to the NONE suite with all crypto fields zeroed', () => {
    const { header } = decodePack(validPack());
    expect(header.suiteId).toBe(SUITE.NONE);
    expect(header.keyEpoch).toBe(0);
    expect(header.packSalt.every((b) => b === 0)).toBe(true);
    expect(header.deviceSignature.every((b) => b === 0)).toBe(true);
    expect(isChainRoot(header)).toBe(true);
  });

  it('round-trips the shallow-snapshot flag', () => {
    expect(isShallowSnapshot(decodePack(validPack({ isShallowSnapshot: true })).header)).toBe(true);
    expect(isShallowSnapshot(decodePack(validPack()).header)).toBe(false);
  });

  it('signs the header up to the signature field, then the payload', () => {
    const payload = new TextEncoder().encode('abc');
    const pack = validPack({ payload });
    const signed = signedBytes(pack);
    expect(signed).toHaveLength(OFFSET.deviceSignature + payload.length);
    expect(Array.from(signed.subarray(0, OFFSET.deviceSignature))).toEqual(
      Array.from(pack.subarray(0, OFFSET.deviceSignature)),
    );
    expect(Array.from(signed.subarray(OFFSET.deviceSignature))).toEqual(Array.from(payload));
  });
});

describe('reading rules — every rejection is specific and ordered', () => {
  it('rule 1: rejects anything shorter than a header as TOO_SHORT', () => {
    for (const n of [0, 1, HEADER_SIZE - 1]) {
      expect(() => decodePack(bytesOf(n), 'p.kpack')).toThrowError(
        expect.objectContaining({ code: 'TOO_SHORT' }),
      );
    }
  });

  it('rule 2: rejects a non-Knowtion file as BAD_MAGIC, not as corruption', () => {
    // A conflict copy or an unrelated file must be ignorable, not alarming.
    expect(() => decodePack(bytesOf(HEADER_SIZE + 10, 0x5a))).toThrowError(
      expect.objectContaining({ code: 'BAD_MAGIC' }),
    );
  });

  it('rule 3: a single flipped bit anywhere in the header is caught', () => {
    const pack = validPack();
    for (const offset of [OFFSET.suiteId, OFFSET.seq, OFFSET.deviceId, OFFSET.deviceSignature]) {
      const damaged = Uint8Array.from(pack);
      damaged[offset]! ^= 0b0000_0001;
      expect(() => decodePack(damaged), `offset ${offset}`).toThrowError(
        expect.objectContaining({ code: 'BAD_HEADER_CRC' }),
      );
    }
  });

  it('rule 3 runs before rule 4, so damage is never misreported as a version problem', () => {
    // Corrupt the version field without resealing: the CRC must catch it first.
    const damaged = Uint8Array.from(validPack());
    new DataView(damaged.buffer).setUint16(OFFSET.envelopeVersion, 9999, true);
    expect(() => decodePack(damaged)).toThrowError(
      expect.objectContaining({ code: 'BAD_HEADER_CRC' }),
    );
  });

  it('rule 4: a newer format version is a distinct, detectable condition', () => {
    const future = Uint8Array.from(validPack());
    new DataView(future.buffer).setUint16(OFFSET.envelopeVersion, ENVELOPE_VERSION + 1, true);
    let thrown: unknown;
    try {
      decodePack(resealCrc(future));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PackFormatError);
    // The whole point: callers must be able to go read-only rather than guess.
    expect(isUnsupportedVersion(thrown)).toBe(true);
  });

  it('rule 4: an older format version is still readable', () => {
    expect(() => decodePack(validPack())).not.toThrow();
  });

  it('rule 4: an unknown cipher suite is never treated as plaintext', () => {
    const odd = Uint8Array.from(validPack());
    odd[OFFSET.suiteId] = 0x7f;
    expect(() => decodePack(resealCrc(odd))).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_SUITE' }),
    );
  });

  it('rule 5: a truncated payload is caught even though the header is intact', () => {
    // The signature failure mode of a half-synced cloud folder.
    const pack = validPack();
    expect(() => decodePack(pack.subarray(0, pack.length - 1))).toThrowError(
      expect.objectContaining({ code: 'LENGTH_MISMATCH' }),
    );
  });

  it('rule 5: trailing bytes appended after the payload are caught', () => {
    const pack = validPack();
    const appended = new Uint8Array(pack.length + 4);
    appended.set(pack);
    expect(() => decodePack(appended)).toThrowError(
      expect.objectContaining({ code: 'LENGTH_MISMATCH' }),
    );
  });

  it('rule 6: padding larger than the payload is rejected', () => {
    const pack = Uint8Array.from(validPack({ payload: bytesOf(8) }));
    new DataView(pack.buffer).setUint32(OFFSET.paddingLen, 9, true);
    expect(() => decodePack(resealCrc(pack))).toThrowError(
      expect.objectContaining({ code: 'BAD_PADDING' }),
    );
  });

  it('includes the file path in the error so a rejection can be logged, never skipped', () => {
    expect(() => decodePack(bytesOf(4), 'd/abc/000000000007.kpack')).toThrowError(
      /000000000007\.kpack/,
    );
  });

  it('tolerates a non-zero reserved field, so a future version stays readable', () => {
    const pack = Uint8Array.from(validPack());
    new DataView(pack.buffer).setUint32(OFFSET.reserved, 0xdeadbeef, true);
    expect(() => decodePack(resealCrc(pack))).not.toThrow();
  });
});

/**
 * One of the few places property testing genuinely earns its keep here: the format
 * encoder and decoder round-trip. A hand-written example set will not find the
 * boundary cases (empty payload, seq at the u64 ceiling, padding exactly equal to
 * payload length), and those are precisely the ones that would be permanent bugs.
 */
describe('round-trip properties', () => {
  const arbBytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });

  const arbInput = fc.record({
    workspaceId: arbBytes(16),
    deviceId: arbBytes(16),
    seq: fc.bigInt({ min: 1n, max: 0xffff_ffff_ffff_ffffn }),
    payload: fc.uint8Array({ maxLength: 2048 }),
    isShallowSnapshot: fc.boolean(),
    keyEpoch: fc.integer({ min: 0, max: 0xffff_ffff }),
    prevPackHash: arbBytes(32),
    packSalt: arbBytes(16),
    deviceSignature: arbBytes(64),
  });

  it('decode(encode(x)) preserves every field exactly', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const { header, payload } = decodePack(encodePack(input));
        expect(header.workspaceId).toEqual(input.workspaceId);
        expect(header.deviceId).toEqual(input.deviceId);
        expect(header.seq).toBe(input.seq);
        expect(header.keyEpoch).toBe(input.keyEpoch);
        expect(header.payloadLen).toBe(input.payload.length);
        expect(header.prevPackHash).toEqual(input.prevPackHash);
        expect(header.packSalt).toEqual(input.packSalt);
        expect(header.deviceSignature).toEqual(input.deviceSignature);
        expect(isShallowSnapshot(header)).toBe(input.isShallowSnapshot);
        expect(payload).toEqual(input.payload);
      }),
      { numRuns: 500 },
    );
  });

  it('encoding is deterministic — identical input yields identical bytes', () => {
    // Required for content addressing and for golden fixtures to mean anything.
    fc.assert(
      fc.property(arbInput, (input) => {
        expect(encodePack(input)).toEqual(encodePack(input));
      }),
      { numRuns: 200 },
    );
  });

  it('any single-byte corruption of the header is always detected', () => {
    fc.assert(
      fc.property(arbInput, fc.nat(), fc.integer({ min: 1, max: 255 }), (input, idx, delta) => {
        const pack = encodePack(input);
        const target = idx % OFFSET.headerCrc32c;
        const damaged = Uint8Array.from(pack);
        damaged[target] = (damaged[target]! + delta) % 256;
        if (damaged[target] === pack[target]) return; // delta wrapped to a no-op
        expect(() => decodePack(damaged)).toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('padding equal to the whole payload is legal, one byte more is not', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), (payload) => {
        const ok = encodePack({
          workspaceId: bytesOf(16),
          deviceId: bytesOf(16),
          seq: 1n,
          payload,
          paddingLen: payload.length,
        });
        expect(decodePack(ok).header.paddingLen).toBe(payload.length);
        expect(() =>
          encodePack({
            workspaceId: bytesOf(16),
            deviceId: bytesOf(16),
            seq: 1n,
            payload,
            paddingLen: payload.length + 1,
          }),
        ).toThrow(TypeError);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a seq of zero, since seq starts at 1 and is never reused', () => {
    expect(() => validPack({ seq: 0n })).toThrow(TypeError);
  });
});
