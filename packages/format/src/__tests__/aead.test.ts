import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AAD_SIZE,
  CONTENT_CHUNK_SIZE,
  NONCE_SIZE,
  PackFormatError,
  SUITE,
  TAG_SIZE,
  chunkAad,
  decryptPayload,
  derivePackKey,
  encryptPayload,
  type PackBinding,
} from '../index.js';

const bytesOf = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

const binding = (over: Partial<PackBinding> = {}): PackBinding => ({
  envelopeVersion: 0,
  suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
  workspaceId: bytesOf(16, 0x11),
  deviceId: bytesOf(16, 0x22),
  seq: 7n,
  keyEpoch: 3,
  ...over,
});

const KEY = bytesOf(32, 0xab);
const SALT = bytesOf(16, 0xcd);

/** Distinct, incompressible bytes, so a mis-ordered chunk cannot pass by luck. */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >> 8) * 17) & 0xff;
  return out;
}

describe('chunk associated data', () => {
  it('is the fixed width FORMAT.md section 6 requires', () => {
    expect(chunkAad(binding(), 0, true)).toHaveLength(AAD_SIZE);
  });

  it('places every field at the offset the specification fixes', () => {
    const aad = chunkAad(
      binding({ envelopeVersion: 0x0201, suiteId: 0x01, seq: 0x0807060504030201n, keyEpoch: 9 }),
      0x0b0a,
      true,
    );
    const view = new DataView(aad.buffer);
    expect(view.getUint16(0, true)).toBe(0x0201);
    expect(aad[2]).toBe(0x01);
    expect(aad.slice(3, 19)).toEqual(bytesOf(16, 0x11));
    expect(aad.slice(19, 35)).toEqual(bytesOf(16, 0x22));
    expect(view.getBigUint64(35, true)).toBe(0x0807060504030201n);
    expect(view.getUint32(43, true)).toBe(9);
    expect(view.getUint32(47, true)).toBe(0x0b0a);
    expect(aad[51]).toBe(1);
  });

  it('changes when any bound field changes', () => {
    // Each of these is a field an attacker would want to move a pack across, so a
    // collision here would silently make one pack replayable as another.
    const base = chunkAad(binding(), 0, false);
    const variants = [
      chunkAad(binding({ envelopeVersion: 1 }), 0, false),
      chunkAad(binding({ suiteId: 0x00 }), 0, false),
      chunkAad(binding({ workspaceId: bytesOf(16, 0x12) }), 0, false),
      chunkAad(binding({ deviceId: bytesOf(16, 0x23) }), 0, false),
      chunkAad(binding({ seq: 8n }), 0, false),
      chunkAad(binding({ keyEpoch: 4 }), 0, false),
      chunkAad(binding(), 1, false),
      chunkAad(binding(), 0, true),
    ];
    for (const variant of variants) expect(variant).not.toEqual(base);
  });
});

describe('pack key derivation', () => {
  it('produces a 32-byte key', () => {
    expect(derivePackKey(KEY, SALT, binding())).toHaveLength(32);
  });

  it('is deterministic', () => {
    expect(derivePackKey(KEY, SALT, binding())).toEqual(derivePackKey(KEY, SALT, binding()));
  });

  it('separates keys by salt and by every identifying field', () => {
    const base = derivePackKey(KEY, SALT, binding());
    const variants = [
      derivePackKey(KEY, bytesOf(16, 0xce), binding()),
      derivePackKey(bytesOf(32, 0xac), SALT, binding()),
      derivePackKey(KEY, SALT, binding({ workspaceId: bytesOf(16, 0x12) })),
      derivePackKey(KEY, SALT, binding({ deviceId: bytesOf(16, 0x23) })),
      derivePackKey(KEY, SALT, binding({ seq: 8n })),
      derivePackKey(KEY, SALT, binding({ keyEpoch: 4 })),
    ];
    for (const variant of variants) expect(variant).not.toEqual(base);
  });

  it('rejects a key or salt of the wrong size', () => {
    expect(() => derivePackKey(bytesOf(31), SALT, binding())).toThrow(TypeError);
    expect(() => derivePackKey(KEY, bytesOf(15), binding())).toThrow(TypeError);
  });
});

describe('content encryption', () => {
  it('round-trips a payload', () => {
    const plaintext = pattern(5000);
    const sealed = encryptPayload(KEY, plaintext, binding());
    expect(decryptPayload(KEY, sealed, binding())).toEqual(plaintext);
  });

  it('round-trips an empty payload as one authenticated chunk', () => {
    // Emptiness must be authenticated: otherwise an empty payload and one truncated to
    // nothing are the same bytes, and the reader cannot tell them apart.
    const sealed = encryptPayload(KEY, new Uint8Array(0), binding());
    expect(sealed).toHaveLength(NONCE_SIZE + TAG_SIZE);
    expect(decryptPayload(KEY, sealed, binding())).toEqual(new Uint8Array(0));
  });

  it('never emits the plaintext', () => {
    const plaintext = pattern(4096);
    const sealed = encryptPayload(KEY, plaintext, binding());
    expect(Buffer.from(sealed).includes(Buffer.from(plaintext.subarray(0, 64)))).toBe(false);
  });

  it('uses a fresh nonce every time, so the same payload seals differently', () => {
    const plaintext = pattern(1024);
    const a = encryptPayload(KEY, plaintext, binding());
    const b = encryptPayload(KEY, plaintext, binding());
    expect(a).not.toEqual(b);
    expect(decryptPayload(KEY, a, binding())).toEqual(decryptPayload(KEY, b, binding()));
  });

  it.each([
    ['just under one chunk', CONTENT_CHUNK_SIZE - 1],
    ['exactly one chunk', CONTENT_CHUNK_SIZE],
    ['one byte over a chunk', CONTENT_CHUNK_SIZE + 1],
    ['exactly two chunks', CONTENT_CHUNK_SIZE * 2],
    ['two chunks and a remainder', CONTENT_CHUNK_SIZE * 2 + 7],
  ])('round-trips a payload of %s', (_label, size) => {
    // The chunk-boundary arithmetic is recovered from length alone at read time, so
    // every boundary case has to be pinned or a reader could split a stream wrongly.
    const plaintext = pattern(size);
    const sealed = encryptPayload(KEY, plaintext, binding());
    expect(decryptPayload(KEY, sealed, binding())).toEqual(plaintext);
  });

  it('round-trips any payload size', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 3000 }), (plaintext) => {
        const sealed = encryptPayload(KEY, plaintext, binding());
        expect(decryptPayload(KEY, sealed, binding())).toEqual(plaintext);
      }),
      { numRuns: 60 },
    );
  });
});

describe('content decryption refuses anything it cannot authenticate', () => {
  const plaintext = pattern(CONTENT_CHUNK_SIZE + 500);
  const sealed = encryptPayload(KEY, plaintext, binding());

  const expectRejection = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(PackFormatError);
      expect((error as PackFormatError).code).toBe(code);
      return;
    }
    throw new Error(`expected a ${code} rejection, but nothing was thrown`);
  };

  it('rejects the wrong key', () => {
    expectRejection(() => decryptPayload(bytesOf(32, 0xac), sealed, binding()), 'DECRYPT_FAILED');
  });

  it('rejects a pack replayed under a different key epoch', () => {
    // The point of binding key_epoch: a pack from a revoked epoch must not silently
    // read as if it belonged to the current one.
    expectRejection(() => decryptPayload(KEY, sealed, binding({ keyEpoch: 4 })), 'DECRYPT_FAILED');
  });

  it('rejects a pack replayed under a different device, seq or workspace', () => {
    for (const over of [
      { deviceId: bytesOf(16, 0x23) },
      { seq: 8n },
      { workspaceId: bytesOf(16, 0x12) },
    ]) {
      expectRejection(() => decryptPayload(KEY, sealed, binding(over)), 'DECRYPT_FAILED');
    }
  });

  it('rejects a single flipped bit anywhere in the stream', () => {
    for (const at of [0, NONCE_SIZE, sealed.length - 1, Math.floor(sealed.length / 2)]) {
      const tampered = Uint8Array.from(sealed);
      tampered[at]! ^= 0x01;
      expectRejection(() => decryptPayload(KEY, tampered, binding()), 'DECRYPT_FAILED');
    }
  });

  it('rejects a stream truncated to a whole chunk', () => {
    // The most dangerous truncation: it is structurally well formed, so only the
    // final-chunk marker in the associated data catches it.
    const oneChunk = sealed.subarray(0, NONCE_SIZE + CONTENT_CHUNK_SIZE + TAG_SIZE);
    expectRejection(() => decryptPayload(KEY, oneChunk, binding()), 'DECRYPT_FAILED');
  });

  it('rejects a stream shorter than a single chunk', () => {
    expectRejection(
      () => decryptPayload(KEY, sealed.subarray(0, NONCE_SIZE + TAG_SIZE - 1), binding()),
      'BAD_CIPHERTEXT_FRAMING',
    );
  });

  it('rejects appended bytes', () => {
    const extended = new Uint8Array(sealed.length + 8);
    extended.set(sealed, 0);
    expectRejection(() => decryptPayload(KEY, extended, binding()), 'DECRYPT_FAILED');
  });

  it('names the offending file when the caller supplies a path', () => {
    try {
      decryptPayload(bytesOf(32, 0xac), sealed, binding(), 'd/aa/bb/000000000001.kpack');
    } catch (error) {
      expect((error as PackFormatError).path).toBe('d/aa/bb/000000000001.kpack');
      expect((error as PackFormatError).message).toContain('000000000001.kpack');
    }
  });
});
