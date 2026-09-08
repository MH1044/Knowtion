/**
 * Pack envelope layout. See FORMAT.md section 3.
 *
 * These offsets are permanent. Knowtion has no backend, so a change here cannot be
 * migrated on a user's behalf: packs already written to a cloud folder would become
 * unreadable, and there is no server to coordinate an upgrade.
 *
 * MAGIC and ENVELOPE_VERSION in particular must stay at offsets 0 and 4 forever, since
 * they are how a reader of ANY future version decides whether it understands the file.
 */

/** ASCII "KNOW". */
export const MAGIC = Uint8Array.from([0x4b, 0x4e, 0x4f, 0x57]);

/** Current envelope version. Treated as a major version. */
export const ENVELOPE_VERSION = 0;

/** Total fixed header size in bytes. */
export const HEADER_SIZE = 180;

export const OFFSET = {
  magic: 0,
  envelopeVersion: 4,
  suiteId: 6,
  flags: 7,
  workspaceId: 8,
  deviceId: 24,
  seq: 40,
  keyEpoch: 48,
  payloadLen: 52,
  paddingLen: 56,
  reserved: 60,
  prevPackHash: 64,
  packSalt: 96,
  deviceSignature: 112,
  headerCrc32c: 176,
} as const;

export const SIZE = {
  magic: 4,
  workspaceId: 16,
  deviceId: 16,
  prevPackHash: 32,
  packSalt: 16,
  deviceSignature: 64,
} as const;

/** Cipher suites. See FORMAT.md section 4. */
export const SUITE = {
  /** Plaintext payload. All crypto fields zero. Used by v0.1. */
  NONE: 0x00,
  /** XChaCha20-Poly1305 content, Argon2id KDF, Ed25519 signatures. Arrives in v0.2. */
  XCHACHA20POLY1305_ARGON2ID: 0x01,
} as const;

export const KNOWN_SUITES: readonly number[] = [SUITE.NONE, SUITE.XCHACHA20POLY1305_ARGON2ID];

/** Header flag bits. Every bit not listed here is reserved and must be written 0. */
export const FLAG = {
  /** Payload is a Loro shallow snapshot rather than an update export. */
  SHALLOW_SNAPSHOT: 0b0000_0001,
} as const;

/**
 * Bytes the signature covers: the header up to but excluding the signature field,
 * concatenated with the payload. The CRC is excluded because it is computed after
 * signing. See FORMAT.md section 5.
 */
export const SIGNED_PREFIX_END = OFFSET.deviceSignature;
