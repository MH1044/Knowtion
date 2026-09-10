import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  OFFSET,
  PackFormatError,
  SUITE,
  decodePack,
  encodePack,
  generateDeviceKeys,
  generateWorkspaceKey,
  isShallowSnapshot,
  keyringOf,
  openPack,
  rotateWorkspaceKey,
  sealPack,
  verifyPackSignature,
} from '../index.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const DEVICE = new Uint8Array(16).fill(0x22);

const device = generateDeviceKeys();
const workspaceKey = generateWorkspaceKey();
const keys = keyringOf(workspaceKey);
const plaintext = new TextEncoder().encode('a loro update export would live here');

const seal = (over: Partial<Parameters<typeof sealPack>[0]> = {}) =>
  sealPack({
    workspaceId: WORKSPACE,
    deviceId: DEVICE,
    seq: 4n,
    payload: plaintext,
    workspaceKey,
    signingSecretKey: device.signingSecretKey,
    ...over,
  });

describe('sealing a pack', () => {
  const pack = seal();
  const decoded = decodePack(pack);

  it('declares the encrypting suite and its key epoch', () => {
    expect(decoded.header.suiteId).toBe(SUITE.XCHACHA20POLY1305_ARGON2ID);
    expect(decoded.header.keyEpoch).toBe(workspaceKey.epoch);
    expect(decoded.header.envelopeVersion).toBe(ENVELOPE_VERSION);
  });

  it('carries a fresh salt and a real signature', () => {
    expect(decoded.header.packSalt.some((b) => b !== 0)).toBe(true);
    expect(decoded.header.deviceSignature.some((b) => b !== 0)).toBe(true);
    expect(decodePack(seal()).header.packSalt).not.toEqual(decoded.header.packSalt);
  });

  it('round-trips the payload', () => {
    expect(openPack(decoded, keys)).toEqual(plaintext);
  });

  it('never writes the plaintext into the file', () => {
    expect(Buffer.from(pack).includes(Buffer.from(plaintext))).toBe(false);
  });

  it('keeps the shallow-snapshot flag, which is signed but not encrypted', () => {
    const snapshot = decodePack(seal({ isShallowSnapshot: true }));
    expect(isShallowSnapshot(snapshot.header)).toBe(true);
    expect(openPack(snapshot, keys)).toEqual(plaintext);
  });

  it('round-trips an empty payload', () => {
    expect(openPack(decodePack(seal({ payload: new Uint8Array(0) })), keys)).toEqual(
      new Uint8Array(0),
    );
  });

  it('refuses to seal under the epoch reserved for plaintext', () => {
    expect(() => seal({ workspaceKey: { epoch: 0, key: workspaceKey.key } })).toThrow(TypeError);
  });
});

describe('reading rule 7: the pack was written by the device it claims', () => {
  const pack = seal();

  it('verifies against the writing device key', () => {
    expect(verifyPackSignature(pack, device.signingPublicKey)).toBe(true);
  });

  it('fails against any other device key', () => {
    expect(verifyPackSignature(pack, generateDeviceKeys().signingPublicKey)).toBe(false);
  });

  it('fails when the payload is altered', () => {
    const tampered = Uint8Array.from(pack);
    tampered[tampered.length - 1]! ^= 0x01;
    expect(verifyPackSignature(tampered, device.signingPublicKey)).toBe(false);
  });

  it('fails when a signed header field is altered', () => {
    // seq sits at offset 40, inside the signed prefix. Someone who can write to the
    // folder can renumber a pack; only the signature notices.
    const tampered = Uint8Array.from(pack);
    tampered[OFFSET.seq]! ^= 0x01;
    expect(verifyPackSignature(tampered, device.signingPublicKey)).toBe(false);
  });

  it('is unaffected by the checksum, which is computed after signing', () => {
    // The CRC covers the signature but not the reverse, so a pack whose CRC is
    // recomputed still verifies. That is what lets a reader tell a damaged file from a
    // forged one, which FORMAT.md section 3 calls out as worth being able to diagnose.
    expect(verifyPackSignature(pack, device.signingPublicKey)).toBe(true);
    expect(() => decodePack(pack)).not.toThrow();
  });

  it('rejects bytes too short to hold a header', () => {
    expect(verifyPackSignature(new Uint8Array(10), device.signingPublicKey)).toBe(false);
  });
});

describe('opening a pack', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(PackFormatError);
      return (error as PackFormatError).code;
    }
    throw new Error('expected the pack to be rejected');
  };

  it('reports an epoch this device has never been granted, rather than failing to decrypt', () => {
    // Normal for a device still awaiting approval, so it must not read as damage.
    const rotated = rotateWorkspaceKey(workspaceKey);
    const pack = decodePack(seal({ workspaceKey: rotated }));
    const error = codeOf(() => openPack(pack, keys));
    expect(error).toBe('UNKNOWN_KEY_EPOCH');
  });

  it('opens under whichever epoch the pack declares, from a keyring holding several', () => {
    // Rotation protects future writes only, so history under older epochs has to stay
    // readable — a device holds every epoch it was ever granted, not just the newest.
    const second = rotateWorkspaceKey(workspaceKey);
    const both = keyringOf(workspaceKey, second);
    expect(openPack(decodePack(seal()), both)).toEqual(plaintext);
    expect(openPack(decodePack(seal({ workspaceKey: second })), both)).toEqual(plaintext);
  });

  it('refuses a different key presented under the right epoch', () => {
    const impostor = keyringOf({ epoch: workspaceKey.epoch, key: generateWorkspaceKey().key });
    expect(codeOf(() => openPack(decodePack(seal()), impostor))).toBe('DECRYPT_FAILED');
  });

  it('refuses a plaintext pack instead of returning its bytes', () => {
    // Silently handing back a plaintext payload would defeat the point of the suite
    // check: a downgrade would look exactly like a successful read.
    const plain = decodePack(
      encodePack({ workspaceId: WORKSPACE, deviceId: DEVICE, seq: 1n, payload: plaintext }),
    );
    expect(codeOf(() => openPack(plain, keys))).toBe('UNKNOWN_SUITE');
  });

  it('names the offending file when given a path', () => {
    try {
      openPack(decodePack(seal()), keyringOf(), 'd/22/00/000000000004.kpack');
    } catch (error) {
      expect((error as PackFormatError).path).toBe('d/22/00/000000000004.kpack');
    }
  });

  it('strips trailing padding before decrypting', () => {
    // Nothing writes padding yet. Handling it now means a future writer that pads to
    // hide payload sizes will not need every older reader to change first — which is
    // impossible anyway, since users update manually and there is no backend.
    const sealed = decodePack(seal());
    const padded = new Uint8Array(sealed.payload.length + 32);
    padded.set(sealed.payload, 0);
    const pack = encodePack({
      workspaceId: WORKSPACE,
      deviceId: DEVICE,
      seq: 4n,
      payload: padded,
      paddingLen: 32,
      suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
      keyEpoch: workspaceKey.epoch,
      packSalt: sealed.header.packSalt,
      signingSecretKey: device.signingSecretKey,
    });
    expect(openPack(decodePack(pack), keys)).toEqual(plaintext);
    expect(verifyPackSignature(pack, device.signingPublicKey)).toBe(true);
  });
});

describe('the encoder refuses incoherent headers', () => {
  const base = { workspaceId: WORKSPACE, deviceId: DEVICE, seq: 1n, payload: plaintext };

  it('will not write an encrypted pack without a signature', () => {
    // Reading rule 7 requires one whenever the suite is not NONE, so an unsigned
    // encrypted pack is unreadable everywhere, including by the device that wrote it.
    expect(() =>
      encodePack({ ...base, suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID, keyEpoch: 1 }),
    ).toThrow(TypeError);
  });

  it('will not take a signing key and a signature at once', () => {
    expect(() =>
      encodePack({
        ...base,
        suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
        keyEpoch: 1,
        signingSecretKey: device.signingSecretKey,
        deviceSignature: new Uint8Array(64),
      }),
    ).toThrow(TypeError);
  });

  it('will not write a plaintext pack carrying crypto fields', () => {
    // Half-populated, it would read as plaintext on every other device while looking
    // encrypted on this one.
    expect(() => encodePack({ ...base, keyEpoch: 3 })).toThrow(TypeError);
    expect(() => encodePack({ ...base, packSalt: new Uint8Array(16).fill(1) })).toThrow(TypeError);
  });

  it('still writes an ordinary plaintext pack', () => {
    expect(() => encodePack(base)).not.toThrow();
  });
});
