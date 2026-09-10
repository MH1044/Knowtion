/**
 * The device registry record: devices/<deviceId>.dev
 *
 * Written once by the device itself when it joins a workspace, and never mutated
 * (FORMAT.md section 9). It answers one question for every other device: which public
 * keys belong to this device identifier.
 *
 * Self-signed, so a record cannot be forged by anyone who can write to the folder but
 * does not hold the device's signing key. That is not the same as being trusted — a
 * stranger can still add a device record, and approving one is a human decision
 * (pairing). The signature only proves that a record claiming to be from device X was
 * written by whoever holds X's key.
 */

import { decodeSidecar, encodeSidecar, SidecarError } from './cbor.js';
import { toHex } from './hash.js';
import { verify, type DevicePublicKeys } from './keys.js';
import { sign } from './keys.js';

export const DEVICE_RECORD_VERSION = 1;

export interface DeviceRecord extends DevicePublicKeys {
  /** 16 raw bytes, matching the device's log prefix. */
  deviceId: Uint8Array;
  /** 16 raw bytes. Which workspace this device belongs to. */
  workspaceId: Uint8Array;
  /** Human-chosen, for the device list. Never trusted for anything else. */
  label: string;
  enrolledAt: number;
}

/** The bytes a record's signature covers: everything except the signature itself. */
function signedBody(record: DeviceRecord): Uint8Array {
  return encodeSidecar({
    v: DEVICE_RECORD_VERSION,
    deviceId: record.deviceId,
    workspaceId: record.workspaceId,
    signingPublicKey: record.signingPublicKey,
    wrappingPublicKey: record.wrappingPublicKey,
    label: record.label,
    enrolledAt: record.enrolledAt,
  });
}

export function encodeDeviceRecord(record: DeviceRecord, signingSecretKey: Uint8Array): Uint8Array {
  const body = signedBody(record);
  return encodeSidecar({ body, sig: sign(body, signingSecretKey) });
}

/**
 * Decode and verify a device record.
 *
 * @throws SidecarError if the record is malformed or its self-signature does not hold.
 * A record that fails here is reported, never silently ignored: on a shared folder it
 * is the difference between a corrupt file and someone attempting to impersonate a
 * device.
 */
export function decodeDeviceRecord(bytes: Uint8Array): DeviceRecord {
  const outer = decodeSidecar(bytes);
  if (outer === null || typeof outer !== 'object') {
    throw new SidecarError('device record is not an object');
  }
  const { body, sig } = outer as { body?: unknown; sig?: unknown };
  if (!(body instanceof Uint8Array) || !(sig instanceof Uint8Array)) {
    throw new SidecarError('device record is missing its body or signature');
  }

  const inner = decodeSidecar(body);
  if (inner === null || typeof inner !== 'object') {
    throw new SidecarError('device record body is not an object');
  }
  const fields = inner as Record<string, unknown>;

  const version = fields['v'];
  if (typeof version !== 'number' || version > DEVICE_RECORD_VERSION) {
    // A newer record is not an error to report as corruption — it means this build is
    // older than the one that wrote it, and FORMAT.md section 7 says go read-only
    // rather than guess.
    throw new SidecarError(
      `device record is version ${String(version)}; this build understands ${DEVICE_RECORD_VERSION}`,
    );
  }

  const record: DeviceRecord = {
    deviceId: expectBytes(fields['deviceId'], 16, 'deviceId'),
    workspaceId: expectBytes(fields['workspaceId'], 16, 'workspaceId'),
    signingPublicKey: expectBytes(fields['signingPublicKey'], 32, 'signingPublicKey'),
    wrappingPublicKey: expectBytes(fields['wrappingPublicKey'], 32, 'wrappingPublicKey'),
    label: typeof fields['label'] === 'string' ? fields['label'] : '',
    enrolledAt: typeof fields['enrolledAt'] === 'number' ? fields['enrolledAt'] : 0,
  };

  if (!verify(sig, body, record.signingPublicKey)) {
    throw new SidecarError(
      `device record for ${toHex(record.deviceId)} failed its own signature check`,
    );
  }
  return record;
}

function expectBytes(value: unknown, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new SidecarError(`device record field ${field} must be ${length} bytes`);
  }
  return value;
}

/**
 * A short, readable fingerprint of a device's signing key.
 *
 * Shown when approving a device so a person can compare it against the other machine.
 * Grouped in fours because that is how people actually read a code aloud.
 */
export function deviceFingerprint(record: DevicePublicKeys): string {
  const hex = toHex(record.signingPublicKey).slice(0, 16).toUpperCase();
  return (hex.match(/.{4}/g) ?? []).join('-');
}
