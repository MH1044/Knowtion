/**
 * Content encryption for cipher suite 0x01. See FORMAT.md sections 4 and 6.
 *
 * Two things in this file become permanent the moment the first encrypted pack exists:
 * the associated-data composition and the chunk framing. Neither can be migrated —
 * there is no backend, and the log is append-only, so a pack already sitting in
 * someone's cloud folder has to stay readable by every later build forever.
 *
 * XChaCha20-Poly1305 rather than AES-GCM, per ADR-0007, and the 192-bit nonce is the
 * whole argument. Several devices write independently with no coordinator, so nobody
 * can count invocations, and AES-GCM's 96-bit random nonce is only safe for roughly
 * 2^32 of them under one key. Here a fresh random nonce per chunk is simply safe.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { PackFormatError } from './errors.js';

/** Plaintext bytes per chunk. FORMAT.md section 6. */
export const CONTENT_CHUNK_SIZE = 262144;

/** XChaCha20 nonce, stored ahead of each chunk's ciphertext. */
export const NONCE_SIZE = 24;

/** Poly1305 tag, appended to each chunk by the AEAD. */
export const TAG_SIZE = 16;

/** A chunk carrying a full CONTENT_CHUNK_SIZE of plaintext, once framed. */
const FRAMED_CHUNK_SIZE = NONCE_SIZE + CONTENT_CHUNK_SIZE + TAG_SIZE;

/** The smallest legal chunk: a nonce and a tag over an empty plaintext. */
const MIN_FRAMED_CHUNK_SIZE = NONCE_SIZE + TAG_SIZE;

/**
 * The header fields identifying a pack, which both the key derivation and the
 * associated data bind. A structural subset of PackHeader, so the envelope can hand a
 * decoded header straight in without restating anything.
 */
export interface PackBinding {
  envelopeVersion: number;
  suiteId: number;
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  seq: bigint;
  keyEpoch: number;
}

/** Fixed width, so concatenation needs no length prefixes and no separator. */
export const AAD_SIZE = 52;

function requireBytes(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new TypeError(
      `${name} must be exactly ${String(expected)} bytes, received ${String(value.length)}`,
    );
  }
}

/**
 * The associated data for one chunk.
 *
 * FORMAT.md section 6 fixes this composition and its order: envelope_version,
 * suite_id, workspace_id, device_id, seq, key_epoch, chunk index, final-chunk marker.
 * It is frozen from the first encrypted pack onwards, so this function must never
 * gain, lose or reorder a field.
 *
 * Note what is deliberately absent. `flags` and `padding_len` are not here, because
 * the specification does not list them and both are already covered by the Ed25519
 * signature over header bytes 0..111 (FORMAT.md section 5). Adding them would be
 * defensible in isolation, and is exactly the sort of well-meant improvement that
 * would make every pack written before it permanently unreadable.
 *
 * Every field is fixed width, so two different field sets cannot produce the same
 * bytes and there is no canonicalisation question to get wrong.
 */
export function chunkAad(binding: PackBinding, chunkIndex: number, isFinal: boolean): Uint8Array {
  requireBytes('workspaceId', binding.workspaceId, 16);
  requireBytes('deviceId', binding.deviceId, 16);

  const aad = new Uint8Array(AAD_SIZE);
  const view = new DataView(aad.buffer);
  view.setUint16(0, binding.envelopeVersion, true);
  aad[2] = binding.suiteId;
  aad.set(binding.workspaceId, 3);
  aad.set(binding.deviceId, 19);
  view.setBigUint64(35, binding.seq, true);
  view.setUint32(43, binding.keyEpoch, true);
  view.setUint32(47, chunkIndex, true);
  aad[51] = isFinal ? 1 : 0;
  return aad;
}

/** Domain separator for the per-pack content key. Never reuse it for anything else. */
const PACK_KEY_INFO = new TextEncoder().encode('knowtion/pack-key/v1');

/**
 * Derive the content key for one pack from the workspace key for its epoch.
 *
 * pack_salt is the random per-pack HKDF salt the envelope already reserves (FORMAT.md
 * section 3), and it is what makes every pack's key distinct even though the workspace
 * key is shared and long-lived.
 *
 * The identifying fields go into `info` as well as into the associated data. That
 * duplication is deliberate: the two bindings are independent, so a mistake in one
 * does not quietly remove the other.
 *
 * HKDF-SHA256 rather than BLAKE3. Section 2's "all hashes are BLAKE3-256" governs
 * hashes that appear in the format — the pack chain, content addresses — not the
 * internals of a key-derivation function, and HKDF is specified over HMAC. SHA-256 is
 * the boring, universally auditable choice there.
 */
export function derivePackKey(
  workspaceKey: Uint8Array,
  packSalt: Uint8Array,
  binding: PackBinding,
): Uint8Array {
  requireBytes('workspaceKey', workspaceKey, 32);
  requireBytes('packSalt', packSalt, 16);
  requireBytes('workspaceId', binding.workspaceId, 16);
  requireBytes('deviceId', binding.deviceId, 16);

  const info = new Uint8Array(PACK_KEY_INFO.length + 44);
  info.set(PACK_KEY_INFO, 0);
  info.set(binding.workspaceId, PACK_KEY_INFO.length);
  info.set(binding.deviceId, PACK_KEY_INFO.length + 16);
  const tail = new DataView(info.buffer, PACK_KEY_INFO.length + 32);
  tail.setBigUint64(0, binding.seq, true);
  tail.setUint32(8, binding.keyEpoch, true);

  return Uint8Array.from(hkdf(sha256, workspaceKey, packSalt, info, 32));
}

/**
 * Encrypt a payload into the framed chunk stream of FORMAT.md section 6.
 *
 * Each chunk is [24-byte nonce][ciphertext][16-byte tag]. The nonce is stored rather
 * than derived from a counter: it costs 24 bytes per 256 KiB, which is nothing, and it
 * removes any dependence on a counter being maintained correctly across a code path
 * nobody will look at again for years.
 *
 * An empty payload still produces exactly one chunk. Emptiness has to be authenticated
 * too — otherwise a genuinely empty payload and one truncated to nothing would be the
 * same bytes, and a reader could not tell them apart.
 */
export function encryptPayload(
  packKey: Uint8Array,
  plaintext: Uint8Array,
  binding: PackBinding,
): Uint8Array {
  requireBytes('packKey', packKey, 32);

  const chunks = Math.max(1, Math.ceil(plaintext.length / CONTENT_CHUNK_SIZE));
  const out = new Uint8Array(plaintext.length + chunks * (NONCE_SIZE + TAG_SIZE));

  let read = 0;
  let write = 0;
  for (let index = 0; index < chunks; index++) {
    const end = Math.min(read + CONTENT_CHUNK_SIZE, plaintext.length);
    const nonce = Uint8Array.from(randomBytes(NONCE_SIZE));
    const aad = chunkAad(binding, index, index === chunks - 1);
    const sealed = xchacha20poly1305(packKey, nonce, aad).encrypt(plaintext.subarray(read, end));
    out.set(nonce, write);
    out.set(sealed, write + NONCE_SIZE);
    write += NONCE_SIZE + sealed.length;
    read = end;
  }
  return out;
}

/**
 * Decrypt a framed chunk stream.
 *
 * Chunk boundaries are recovered from the length alone, because every chunk but the
 * last carries exactly CONTENT_CHUNK_SIZE of plaintext. That is unambiguous: a stream
 * of n full chunks and one of n-1 full chunks plus a final one always differ in
 * length, so no framing field is needed.
 *
 * Truncation is caught for free by the final-chunk marker. Drop the trailing chunks of
 * a pack and the new last chunk gets decrypted with is_final set, while it was sealed
 * with is_final clear — so its tag fails and the pack is rejected rather than silently
 * yielding a shorter document.
 *
 * @throws PackFormatError with BAD_CIPHERTEXT_FRAMING if the stream is not a whole
 * number of well-formed chunks, or DECRYPT_FAILED if a tag does not verify — which
 * means either the wrong key epoch or a tampered file, and the caller cannot tell
 * which.
 */
export function decryptPayload(
  packKey: Uint8Array,
  ciphertext: Uint8Array,
  binding: PackBinding,
  path?: string,
): Uint8Array {
  requireBytes('packKey', packKey, 32);

  if (ciphertext.length < MIN_FRAMED_CHUNK_SIZE) {
    throw new PackFormatError(
      'BAD_CIPHERTEXT_FRAMING',
      `encrypted payload of ${String(ciphertext.length)} bytes is shorter than the smallest ` +
        `possible chunk (${String(MIN_FRAMED_CHUNK_SIZE)} bytes)`,
      path,
    );
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  let index = 0;

  for (;;) {
    const remaining = ciphertext.length - offset;
    const isFinal = remaining <= FRAMED_CHUNK_SIZE;
    const framed = isFinal ? remaining : FRAMED_CHUNK_SIZE;
    if (framed < MIN_FRAMED_CHUNK_SIZE) {
      throw new PackFormatError(
        'BAD_CIPHERTEXT_FRAMING',
        `chunk ${String(index)} has ${String(framed)} bytes, fewer than a nonce and a tag`,
        path,
      );
    }

    const nonce = ciphertext.subarray(offset, offset + NONCE_SIZE);
    const sealed = ciphertext.subarray(offset + NONCE_SIZE, offset + framed);
    let opened: Uint8Array;
    try {
      opened = xchacha20poly1305(packKey, nonce, chunkAad(binding, index, isFinal)).decrypt(sealed);
    } catch {
      // The AEAD does not say why, and neither should we: a wrong key and a forged tag
      // are indistinguishable by design, and guessing in the message would mislead.
      throw new PackFormatError(
        'DECRYPT_FAILED',
        `chunk ${String(index)} failed authentication: the key epoch is wrong, or the pack has ` +
          'been altered since it was written',
        path,
      );
    }

    parts.push(opened);
    total += opened.length;
    offset += framed;
    index++;
    if (isFinal) break;
  }

  const plaintext = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    plaintext.set(part, write);
    write += part.length;
  }
  return plaintext;
}
