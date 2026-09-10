/**
 * Pack envelope encoder and decoder. See FORMAT.md section 3.
 *
 * The header is fixed at 180 bytes and carries every crypto field from the very first
 * byte Knowtion ever writes, zero-filled while suite_id is NONE. That is deliberate:
 * key_epoch, prev_pack_hash, pack_salt, padding_len and the signature slot cannot be
 * added later without moving fields, and there is no backend that could migrate packs
 * already sitting in a user's cloud folder.
 */

import { crc32c } from './crc32c.js';
import {
  ENVELOPE_VERSION,
  FLAG,
  HEADER_SIZE,
  KNOWN_SUITES,
  MAGIC,
  OFFSET,
  SIZE,
  SUITE,
} from './constants.js';
import { PackFormatError } from './errors.js';
import { hash } from './hash.js';
import { sign, verify } from './keys.js';

export interface PackHeader {
  envelopeVersion: number;
  suiteId: number;
  flags: number;
  /** 16 raw bytes of a UUIDv7. */
  workspaceId: Uint8Array;
  /** 16 raw bytes of a UUIDv7. The writing device. */
  deviceId: Uint8Array;
  /** Monotonic per device, starts at 1, never reused. */
  seq: bigint;
  keyEpoch: number;
  payloadLen: number;
  paddingLen: number;
  /** BLAKE3-256 of the previous pack this device wrote. All zero at a chain root. */
  prevPackHash: Uint8Array;
  packSalt: Uint8Array;
  deviceSignature: Uint8Array;
}

/** What a caller must supply to write a pack. Crypto fields default to zeros. */
export interface PackInput {
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  seq: bigint;
  payload: Uint8Array;
  isShallowSnapshot?: boolean;
  suiteId?: number;
  keyEpoch?: number;
  paddingLen?: number;
  prevPackHash?: Uint8Array;
  packSalt?: Uint8Array;
  deviceSignature?: Uint8Array;
  /**
   * Sign this pack with the device's Ed25519 key.
   *
   * Preferred over passing deviceSignature directly, and the two are mutually
   * exclusive. The encoder is the only code that knows the byte layout, so letting it
   * sign removes the one bug a caller could not detect: signing the wrong bytes
   * produces a pack that verifies nowhere and looks fine locally.
   */
  signingSecretKey?: Uint8Array;
}

export interface DecodedPack {
  header: PackHeader;
  payload: Uint8Array;
}

function requireLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new TypeError(`${name} must be exactly ${expected} bytes, received ${value.length}`);
  }
}

/** Chain root sentinel: a pack that is the first this device wrote. */
export const ZERO_HASH: Uint8Array = new Uint8Array(SIZE.prevPackHash);

export function isChainRoot(header: PackHeader): boolean {
  return header.prevPackHash.every((b) => b === 0);
}

export function isShallowSnapshot(header: PackHeader): boolean {
  return (header.flags & FLAG.SHALLOW_SNAPSHOT) !== 0;
}

/**
 * Serialise a pack. The returned bytes are the complete file contents.
 *
 * @throws TypeError if a fixed-width field is the wrong size, or seq does not fit u64.
 */
export function encodePack(input: PackInput): Uint8Array {
  const {
    workspaceId,
    deviceId,
    seq,
    payload,
    isShallowSnapshot: shallow = false,
    suiteId = SUITE.NONE,
    keyEpoch = 0,
    paddingLen = 0,
    prevPackHash = ZERO_HASH,
    packSalt = new Uint8Array(SIZE.packSalt),
    deviceSignature = new Uint8Array(SIZE.deviceSignature),
    signingSecretKey,
  } = input;

  if (signingSecretKey !== undefined && input.deviceSignature !== undefined) {
    throw new TypeError('pass either signingSecretKey or deviceSignature, not both');
  }
  if (
    suiteId !== SUITE.NONE &&
    signingSecretKey === undefined &&
    input.deviceSignature === undefined
  ) {
    // Reading rule 7 requires a signature whenever the suite is not NONE, so a pack
    // written without one is unreadable everywhere including here. Failing at the
    // writer is the only place this is cheap to notice.
    throw new TypeError(`suite 0x${suiteId.toString(16).padStart(2, '0')} packs must be signed`);
  }
  if (suiteId === SUITE.NONE && (keyEpoch !== 0 || !packSalt.every((b) => b === 0))) {
    // FORMAT.md section 4: under NONE the crypto fields are all zero. A half-populated
    // header would read as plaintext on every other device while looking encrypted here.
    throw new TypeError('suite NONE packs must leave keyEpoch and packSalt zero');
  }

  requireLength('workspaceId', workspaceId, SIZE.workspaceId);
  requireLength('deviceId', deviceId, SIZE.deviceId);
  requireLength('prevPackHash', prevPackHash, SIZE.prevPackHash);
  requireLength('packSalt', packSalt, SIZE.packSalt);
  requireLength('deviceSignature', deviceSignature, SIZE.deviceSignature);

  if (seq < 1n || seq > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError(`seq must be between 1 and 2^64-1, received ${seq}`);
  }
  if (paddingLen > payload.length) {
    throw new TypeError(`paddingLen ${paddingLen} exceeds payload length ${payload.length}`);
  }
  if (payload.length > 0xffff_ffff) {
    throw new TypeError(`payload of ${payload.length} bytes exceeds the u32 length field`);
  }

  const bytes = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(bytes.buffer);

  bytes.set(MAGIC, OFFSET.magic);
  view.setUint16(OFFSET.envelopeVersion, ENVELOPE_VERSION, true);
  bytes[OFFSET.suiteId] = suiteId;
  bytes[OFFSET.flags] = shallow ? FLAG.SHALLOW_SNAPSHOT : 0;
  bytes.set(workspaceId, OFFSET.workspaceId);
  bytes.set(deviceId, OFFSET.deviceId);
  view.setBigUint64(OFFSET.seq, seq, true);
  view.setUint32(OFFSET.keyEpoch, keyEpoch, true);
  view.setUint32(OFFSET.payloadLen, payload.length, true);
  view.setUint32(OFFSET.paddingLen, paddingLen, true);
  // OFFSET.reserved stays zero; readers must tolerate a future non-zero value.
  bytes.set(prevPackHash, OFFSET.prevPackHash);
  bytes.set(packSalt, OFFSET.packSalt);
  bytes.set(deviceSignature, OFFSET.deviceSignature);
  bytes.set(payload, HEADER_SIZE);

  // Signed here, with the payload in place and the signature slot still zero — which
  // is why signedBytes skips that slot. The CRC below deliberately covers the result.
  if (signingSecretKey !== undefined) {
    bytes.set(sign(packSignatureMessage(bytes), signingSecretKey), OFFSET.deviceSignature);
  }

  // Computed last, over everything before it, including the signature slot.
  view.setUint32(OFFSET.headerCrc32c, crc32c(bytes.subarray(0, OFFSET.headerCrc32c)), true);

  return bytes;
}

/**
 * The bytes an Ed25519 signature covers: header up to the signature field, then the
 * payload. See FORMAT.md section 5. Exported so the crypto layer arriving in v0.2
 * cannot disagree with the encoder about what was signed.
 */
export function signedBytes(pack: Uint8Array): Uint8Array {
  const out = new Uint8Array(OFFSET.deviceSignature + (pack.length - HEADER_SIZE));
  out.set(pack.subarray(0, OFFSET.deviceSignature), 0);
  out.set(pack.subarray(HEADER_SIZE), OFFSET.deviceSignature);
  return out;
}

/**
 * What the Ed25519 signature is actually computed over: BLAKE3-256 of the signed
 * bytes, per FORMAT.md section 5.
 */
function packSignatureMessage(pack: Uint8Array): Uint8Array {
  return hash(signedBytes(pack));
}

/**
 * Reading rule 7: the pack was written by the device it claims.
 *
 * Separate from decodePack because the public key comes from the device registry,
 * which this layer has no access to — the same reason rule 8 lives in the sync engine.
 * Returns false rather than throwing, since an unverifiable pack in a folder anyone
 * could write to is an ordinary condition that the caller must report and skip, not an
 * exceptional one.
 */
export function verifyPackSignature(pack: Uint8Array, signingPublicKey: Uint8Array): boolean {
  if (pack.length < HEADER_SIZE) return false;
  const signature = pack.subarray(
    OFFSET.deviceSignature,
    OFFSET.deviceSignature + SIZE.deviceSignature,
  );
  return verify(signature, packSignatureMessage(pack), signingPublicKey);
}

/**
 * Parse and validate a pack.
 *
 * Applies reading rules 1 to 6 of FORMAT.md section 3, in the order the specification
 * requires. Rules 7 and 8 — signature verification and hash-chain continuity — need
 * state this layer does not have (the device registry, and the previous pack from the
 * same device), so they belong to the sync engine. That split is why every rejection
 * carries a machine-readable code: the caller has to be able to tell "not our file"
 * from "our file, damaged" without parsing an error string.
 *
 * @param bytes complete file contents
 * @param path optional source path, included in errors so logs can name the file
 * @throws PackFormatError with a specific code on any rule failure
 */
export function decodePack(bytes: Uint8Array, path?: string): DecodedPack {
  // Rule 1: at least a header.
  if (bytes.length < HEADER_SIZE) {
    throw new PackFormatError(
      'TOO_SHORT',
      `expected at least ${HEADER_SIZE} bytes, received ${bytes.length}; ` +
        'most likely a partially synced file',
      path,
    );
  }

  // Rule 2: magic.
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[OFFSET.magic + i] !== MAGIC[i]) {
      throw new PackFormatError('BAD_MAGIC', 'not a Knowtion pack', path);
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Rule 3: header checksum, before trusting any other field.
  const expectedCrc = view.getUint32(OFFSET.headerCrc32c, true);
  const actualCrc = crc32c(bytes.subarray(0, OFFSET.headerCrc32c));
  if (expectedCrc !== actualCrc) {
    throw new PackFormatError(
      'BAD_HEADER_CRC',
      `header checksum mismatch: declared ${expectedCrc}, computed ${actualCrc}; ` +
        'the file is damaged rather than merely unexpected',
      path,
    );
  }

  // Rule 4: version. A higher version means the caller must go read-only.
  const envelopeVersion = view.getUint16(OFFSET.envelopeVersion, true);
  if (envelopeVersion > ENVELOPE_VERSION) {
    throw new PackFormatError(
      'UNSUPPORTED_VERSION',
      `pack is format version ${envelopeVersion}, this build understands ${ENVELOPE_VERSION}; ` +
        'this workspace was written by a newer Knowtion and must not be written to',
      path,
    );
  }

  const suiteId = bytes[OFFSET.suiteId]!;
  if (!KNOWN_SUITES.includes(suiteId)) {
    throw new PackFormatError(
      'UNKNOWN_SUITE',
      `unknown cipher suite 0x${suiteId.toString(16).padStart(2, '0')}; ` +
        'refusing to treat an unknown suite as plaintext',
      path,
    );
  }

  const payloadLen = view.getUint32(OFFSET.payloadLen, true);

  // Rule 5: declared length must match the file exactly.
  if (bytes.length !== HEADER_SIZE + payloadLen) {
    throw new PackFormatError(
      'LENGTH_MISMATCH',
      `declared payload of ${payloadLen} implies a ${HEADER_SIZE + payloadLen} byte file, ` +
        `received ${bytes.length}`,
      path,
    );
  }

  // Rule 6: padding must fit inside the payload.
  const paddingLen = view.getUint32(OFFSET.paddingLen, true);
  if (paddingLen > payloadLen) {
    throw new PackFormatError(
      'BAD_PADDING',
      `padding of ${paddingLen} exceeds payload of ${payloadLen}`,
      path,
    );
  }

  const slice = (offset: number, size: number) =>
    Uint8Array.prototype.slice.call(bytes, offset, offset + size);

  return {
    header: {
      envelopeVersion,
      suiteId,
      flags: bytes[OFFSET.flags]!,
      workspaceId: slice(OFFSET.workspaceId, SIZE.workspaceId),
      deviceId: slice(OFFSET.deviceId, SIZE.deviceId),
      seq: view.getBigUint64(OFFSET.seq, true),
      keyEpoch: view.getUint32(OFFSET.keyEpoch, true),
      payloadLen,
      paddingLen,
      prevPackHash: slice(OFFSET.prevPackHash, SIZE.prevPackHash),
      packSalt: slice(OFFSET.packSalt, SIZE.packSalt),
      deviceSignature: slice(OFFSET.deviceSignature, SIZE.deviceSignature),
    },
    payload: slice(HEADER_SIZE, payloadLen),
  };
}
