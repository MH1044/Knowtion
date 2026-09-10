/**
 * BLAKE3-256, the hash FORMAT.md specifies throughout.
 *
 * Used for the per-device pack chain, and later for content-addressing attachments —
 * where it is keyed rather than plain, so that seeing the cloud layout does not let an
 * observer confirm a known file is present (FORMAT.md section 10).
 *
 * Chosen over SHA-256 because attachment hashing will run over whole files and BLAKE3
 * is substantially faster there, and because using one hash everywhere means one
 * decision to get right rather than two.
 */

import { blake3 } from '@noble/hashes/blake3.js';

/**
 * 32 bytes.
 *
 * Copied into a plain Uint8Array rather than returned directly: the library's return
 * type is parameterised over ArrayBufferLike, which does not assign to a Uint8Array
 * backed by an ArrayBuffer and produces variance errors at every call site. Thirty-two
 * bytes is not worth the friction.
 */
export function hash(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(blake3(bytes));
}

/**
 * Keyed BLAKE3, for content addresses that must not be guessable.
 *
 * @param key exactly 32 bytes, derived from the workspace key
 */
export function keyedHash(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new TypeError(`a keyed hash needs a 32-byte key, received ${String(key.length)}`);
  }
  return Uint8Array.from(blake3(bytes, { key }));
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** `bytes` only ever yields values 0-255, which HEX always has an entry for. */
function hexDigits(byte: number): string {
  const value = HEX[byte];
  if (value === undefined) throw new Error(`no hex digits for byte ${String(byte)}`);
  return value;
}

/** Lowercase hex. FORMAT.md section 8 forbids base64 in names. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += hexDigits(b);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
