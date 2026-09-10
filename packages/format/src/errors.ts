/**
 * Typed rejection reasons for pack decoding.
 *
 * FORMAT.md section 3 requires that a rejected pack is logged with its path and the
 * failing rule, and never silently skipped: in a synced folder, silently skipping a
 * file is indistinguishable from data loss. Carrying a machine-readable reason is what
 * makes that requirement enforceable rather than aspirational, and it lets the sync
 * engine tell apart "this is not one of our files" from "one of our files is damaged".
 */

export type PackRejectionCode =
  /** Shorter than a header. Almost always a partially synced file. */
  | 'TOO_SHORT'
  /** Not a Knowtion pack at all. A conflict copy or an unrelated file. */
  | 'BAD_MAGIC'
  /** Header failed its checksum. The file is damaged, not merely unexpected. */
  | 'BAD_HEADER_CRC'
  /** Written by a newer Knowtion. The caller must go read-only, not guess. */
  | 'UNSUPPORTED_VERSION'
  /** A cipher suite we do not know. Never fall back to treating it as plaintext. */
  | 'UNKNOWN_SUITE'
  /** File length disagrees with the declared payload length. Truncated or appended to. */
  | 'LENGTH_MISMATCH'
  /** Declared padding exceeds the payload it is supposed to sit inside. */
  | 'BAD_PADDING'
  /** A field that must be zero for this suite was not. */
  | 'NONZERO_RESERVED_FIELD'
  /** The encrypted payload is not a whole number of well-formed chunks. */
  | 'BAD_CIPHERTEXT_FRAMING'
  /** A chunk's tag did not verify: the wrong key epoch, or the file was altered. */
  | 'DECRYPT_FAILED'
  /** Encrypted under a key generation this device has never been granted. */
  | 'UNKNOWN_KEY_EPOCH'
  /** The signature did not verify against the registered key for that device. */
  | 'BAD_SIGNATURE';

export class PackFormatError extends Error {
  readonly code: PackRejectionCode;
  /** Present when the caller supplied one, so logs can name the offending file. */
  readonly path: string | undefined;

  constructor(code: PackRejectionCode, message: string, path?: string) {
    super(path === undefined ? message : `${message} (${path})`);
    this.name = 'PackFormatError';
    this.code = code;
    this.path = path;
  }
}

/**
 * True when the pack was written by a format version we do not understand.
 *
 * Callers MUST treat this as "stop writing to this workspace" rather than as an
 * ordinary read failure. A device that writes into a workspace it only partly
 * understands corrupts it for every other device, and there is no server to notice.
 */
export function isUnsupportedVersion(error: unknown): boolean {
  return error instanceof PackFormatError && error.code === 'UNSUPPORTED_VERSION';
}
