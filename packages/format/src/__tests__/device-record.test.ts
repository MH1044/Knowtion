import { describe, expect, it } from 'vitest';

import { SidecarError, decodeSidecar, encodeSidecar } from '../cbor.js';
import {
  decodeDeviceRecord,
  deviceFingerprint,
  encodeDeviceRecord,
  type DeviceRecord,
} from '../device-record.js';
import { generateDeviceKeys, sign, verify } from '../keys.js';

const keys = generateDeviceKeys();

const record = (over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  deviceId: new Uint8Array(16).fill(0xaa),
  workspaceId: new Uint8Array(16).fill(0x11),
  signingPublicKey: keys.signingPublicKey,
  wrappingPublicKey: keys.wrappingPublicKey,
  label: "Mo's laptop",
  enrolledAt: 1_700_000_000_000,
  ...over,
});

describe('CBOR sidecars', () => {
  it('round-trips ordinary records including binary fields', () => {
    const value = { a: 1, b: 'two', c: Uint8Array.from([1, 2, 3]), d: [true, null] };
    expect(decodeSidecar(encodeSidecar(value))).toEqual(value);
  });

  it('refuses a record that could pollute a prototype', () => {
    // Unlike most injection, this corrupts the runtime rather than one value, so it is
    // refused at the decoder rather than guarded at every call site.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hostile = encodeSidecar({ [key]: { polluted: true } });
      expect(() => decodeSidecar(hostile), key).toThrowError(SidecarError);
    }
  });

  it('refuses a forbidden key nested deep inside', () => {
    // A computed key is required: a literal __proto__ in an object literal sets the
    // prototype instead of creating a property, so there would be nothing to encode.
    const hostile = encodeSidecar({ outer: { inner: [{ ['__proto__']: { x: 1 } }] } });
    expect(() => decodeSidecar(hostile)).toThrowError(SidecarError);
  });

  it('does not silently rename a forbidden key, which the library default does', () => {
    // Left to its default the library rewrites __proto__ to __proto_ — pollution-safe,
    // but it alters the data and makes the key impossible to report. FORMAT.md requires
    // rejection, so a renamed key surviving decode would be a silent format violation.
    const hostile = encodeSidecar({ ['__proto__']: 1 });
    let thrown: unknown;
    try {
      decodeSidecar(hostile);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SidecarError);
    expect(String(thrown)).toContain('__proto__');
  });

  it('reports undecodable bytes rather than throwing something opaque', () => {
    expect(() => decodeSidecar(Uint8Array.from([0xff, 0xff, 0xff]))).toThrowError(SidecarError);
  });
});

describe('device keys', () => {
  it('mints keys of the expected sizes', () => {
    expect(keys.signingPublicKey).toHaveLength(32);
    expect(keys.signingSecretKey).toHaveLength(32);
    expect(keys.wrappingPublicKey).toHaveLength(32);
  });

  it('signs and verifies', () => {
    const message = new TextEncoder().encode('a pack header');
    const signature = sign(message, keys.signingSecretKey);
    expect(verify(signature, message, keys.signingPublicKey)).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    const signature = sign(new TextEncoder().encode('original'), keys.signingSecretKey);
    expect(verify(signature, new TextEncoder().encode('tampered'), keys.signingPublicKey)).toBe(
      false,
    );
  });

  it('rejects a signature from a different device', () => {
    const other = generateDeviceKeys();
    const message = new TextEncoder().encode('x');
    expect(verify(sign(message, other.signingSecretKey), message, keys.signingPublicKey)).toBe(
      false,
    );
  });

  it('returns false for malformed input rather than throwing', () => {
    // A corrupt record is ordinary when reading a folder anyone can write to, and a
    // caller forced to wrap every check in try/catch eventually stops checking.
    expect(verify(new Uint8Array(10), new Uint8Array(4), keys.signingPublicKey)).toBe(false);
    expect(verify(new Uint8Array(64), new Uint8Array(4), new Uint8Array(3))).toBe(false);
  });

  it('mints a different key every time', () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    expect(a.signingSecretKey).not.toEqual(b.signingSecretKey);
  });
});

describe('device records', () => {
  it('round-trips every field', () => {
    const original = record();
    const decoded = decodeDeviceRecord(encodeDeviceRecord(original, keys.signingSecretKey));
    expect(decoded).toEqual(original);
  });

  it('rejects a record signed by a different key than it claims', () => {
    // Anyone can write into a shared folder. The signature is what stops them writing a
    // record that claims to be another device.
    const impostor = generateDeviceKeys();
    const forged = encodeDeviceRecord(record(), impostor.signingSecretKey);
    expect(() => decodeDeviceRecord(forged)).toThrowError(/signature/i);
  });

  it('rejects a record whose body was altered after signing', () => {
    const bytes = encodeDeviceRecord(record(), keys.signingSecretKey);
    const outer = decodeSidecar(bytes) as { body: Uint8Array; sig: Uint8Array };
    const tampered = Uint8Array.from(outer.body);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decodeDeviceRecord(encodeSidecar({ body: tampered, sig: outer.sig }))).toThrow();
  });

  it('rejects fields of the wrong size instead of trusting them', () => {
    const bad = encodeSidecar({
      body: encodeSidecar({ v: 1, deviceId: new Uint8Array(8) }),
      sig: new Uint8Array(64),
    });
    expect(() => decodeDeviceRecord(bad)).toThrowError(/16 bytes/);
  });

  it('refuses a record from a newer format version rather than guessing', () => {
    const body = encodeSidecar({ v: 99, deviceId: new Uint8Array(16) });
    const bytes = encodeSidecar({ body, sig: sign(body, keys.signingSecretKey) });
    expect(() => decodeDeviceRecord(bytes)).toThrowError(/version 99/);
  });

  it('produces a fingerprint a person can read aloud', () => {
    const fingerprint = deviceFingerprint(record());
    expect(fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    // Stable for the same key, and different for another device.
    expect(deviceFingerprint(record())).toBe(fingerprint);
    expect(deviceFingerprint(generateDeviceKeys())).not.toBe(fingerprint);
  });
});
