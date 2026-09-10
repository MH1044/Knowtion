/**
 * Writing and reading a pack under cipher suite 0x01. See FORMAT.md sections 4 to 6.
 *
 * This is the join between the two halves that arrived separately: the envelope, which
 * owns the byte layout and the signature, and the AEAD, which owns the content
 * encryption. Keeping the join in one small file is deliberate — a pack that is
 * encrypted but unsigned, or signed but under the wrong binding, is exactly the sort of
 * thing that gets written once and discovered a year later on somebody else's machine.
 *
 * Nothing here decides WHETHER to encrypt. That is the workspace's setting, and
 * flipping it is a one-way door (ADR-0007): the log is append-only, so plaintext
 * already in a provider's storage cannot be recalled, and switching a live workspace
 * over means deleting and re-seeding the remote.
 */

import { ENVELOPE_VERSION, SUITE } from './constants.js';
import { PackFormatError } from './errors.js';
import { decryptPayload, derivePackKey, encryptPayload, type PackBinding } from './aead.js';
import { encodePack, type DecodedPack, type PackHeader } from './envelope.js';
import { FIRST_KEY_EPOCH, type WorkspaceKey } from './key-wrap.js';
import { randomBytes } from '@noble/hashes/utils.js';

/** Per-pack HKDF salt, the size FORMAT.md section 3 reserves. */
const PACK_SALT_SIZE = 16;

export interface SealPackInput {
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  seq: bigint;
  /** Plaintext: a Loro update export or a shallow snapshot. */
  payload: Uint8Array;
  isShallowSnapshot?: boolean;
  prevPackHash?: Uint8Array;
  workspaceKey: WorkspaceKey;
  signingSecretKey: Uint8Array;
}

/** Epoch to key. A device holds every epoch it was ever granted, not only the latest. */
export type Keyring = ReadonlyMap<number, Uint8Array>;

/**
 * Build a keyring, so no call site has to get the epoch and the key the right way
 * round in a Map literal.
 */
export function keyringOf(...keys: readonly WorkspaceKey[]): Keyring {
  return new Map(keys.map((k) => [k.epoch, k.key]));
}

/** The fields of a header that both the key derivation and the associated data bind. */
function bindingOf(
  header: Pick<PackHeader, 'workspaceId' | 'deviceId' | 'seq' | 'keyEpoch'>,
): PackBinding {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
    workspaceId: header.workspaceId,
    deviceId: header.deviceId,
    seq: header.seq,
    keyEpoch: header.keyEpoch,
  };
}

/**
 * Encrypt, sign and serialise a pack. The result is the complete file contents.
 *
 * The salt is fresh per pack, which is what makes every pack's content key distinct
 * under one long-lived workspace key, and it is why the envelope reserved the field
 * from the first byte v0.1 ever wrote.
 */
export function sealPack(input: SealPackInput): Uint8Array {
  const { workspaceKey } = input;
  if (workspaceKey.epoch < FIRST_KEY_EPOCH) {
    // Epoch 0 means suite NONE. An encrypted pack claiming it would be unreadable by
    // the rule that makes key_epoch meaningful on its own.
    throw new TypeError(`an encrypted pack cannot use key epoch ${workspaceKey.epoch}`);
  }

  const packSalt = Uint8Array.from(randomBytes(PACK_SALT_SIZE));
  const binding = bindingOf({
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    seq: input.seq,
    keyEpoch: workspaceKey.epoch,
  });
  const packKey = derivePackKey(workspaceKey.key, packSalt, binding);

  return encodePack({
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    seq: input.seq,
    payload: encryptPayload(packKey, input.payload, binding),
    ...(input.isShallowSnapshot === undefined
      ? {}
      : { isShallowSnapshot: input.isShallowSnapshot }),
    ...(input.prevPackHash === undefined ? {} : { prevPackHash: input.prevPackHash }),
    suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
    keyEpoch: workspaceKey.epoch,
    packSalt,
    signingSecretKey: input.signingSecretKey,
  });
}

/**
 * Recover the plaintext payload of a pack that decodePack has already validated.
 *
 * Takes the decoded pack rather than raw bytes so the reading rules stay in one order
 * and one place: decodePack applies rules 1 to 6, the sync engine applies rule 7
 * (signature, which needs the device registry) and rule 8 (chain), and only then is
 * there any reason to spend work on decryption.
 *
 * Padding is stripped from the tail of the payload before anything else, which is what
 * "counted inside payload_len" in section 3 means. It is signed along with the rest of
 * the header, so it cannot be moved by anyone who does not hold the device key. Nothing
 * writes padding yet; handling it here means a future writer that does will not need
 * every older reader to change.
 *
 * @throws PackFormatError — UNKNOWN_KEY_EPOCH when this device holds no key for the
 * pack's generation, which is a normal state for a device awaiting approval rather
 * than damage, and DECRYPT_FAILED when the content does not authenticate.
 */
export function openPack(decoded: DecodedPack, keys: Keyring, path?: string): Uint8Array {
  const { header, payload } = decoded;

  if (header.suiteId === SUITE.NONE) {
    throw new PackFormatError(
      'UNKNOWN_SUITE',
      'this pack is plaintext; openPack is only for encrypted packs',
      path,
    );
  }

  const workspaceKey = keys.get(header.keyEpoch);
  if (workspaceKey === undefined) {
    throw new PackFormatError(
      'UNKNOWN_KEY_EPOCH',
      `pack is encrypted under key generation ${header.keyEpoch}, which this device has ` +
        'not been granted; it needs a key wrap for that epoch before it can read this',
      path,
    );
  }

  // Rule 6 already guaranteed this fits, so the subarray cannot go negative.
  const body =
    header.paddingLen === 0 ? payload : payload.subarray(0, payload.length - header.paddingLen);

  const binding = bindingOf(header);
  return decryptPayload(derivePackKey(workspaceKey, header.packSalt, binding), body, binding, path);
}
