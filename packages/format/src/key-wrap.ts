/**
 * The workspace key, and the ways it is wrapped. See ADR-0007.
 *
 * The key that actually encrypts content is random and independent of any passphrase.
 * That is the whole reason rotation is possible: the same key can be re-wrapped to a
 * new recipient without re-encrypting a single pack, and an append-only log could never
 * be re-encrypted anyway. Deriving the content key straight from a passphrase is rclone
 * crypt's permanent mistake — its users cannot change their password on existing data,
 * ever, because the password IS the key.
 *
 * There are three wraps, and only two of them are files in the cloud folder:
 *
 *   keys/<epoch>/<deviceId>.wrap   sealed to that device's X25519 key, written by the
 *                                  APPROVING device, never by the subject (FORMAT.md
 *                                  section 9)
 *   keys/<epoch>/recovery.wrap     sealed under the recovery phrase via Argon2id
 *
 * The third is the OS keychain, and it deliberately has no representation here. It is
 * a local file the host protects with safeStorage, so it belongs to apps/desktop; a
 * keychain copy in the sync folder would be a keychain copy in the cloud.
 *
 * Rotation exists because revocation implies it. A revoked device keeps every pack it
 * has already read — that cannot be undone — so rotation protects future writes only,
 * and every epoch's key has to stay unwrappable forever for the history below it to
 * remain readable.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { NONCE_SIZE } from './aead.js';
import { decodeSidecar, encodeSidecar } from './cbor.js';
import { equalBytes } from './hash.js';
import { recoveryPhraseEntropy } from './recovery-phrase.js';

export const KEY_WRAP_VERSION = 1;
export const WORKSPACE_KEY_SIZE = 32;

/**
 * The first epoch that can carry encrypted content.
 *
 * Epoch 0 is reserved for suite NONE, whose crypto fields are all zero. Starting real
 * epochs at 1 makes `key_epoch === 0` mean "this pack is not encrypted" outright,
 * rather than something a reader has to cross-check against suite_id to be sure of.
 */
export const FIRST_KEY_EPOCH = 1;

const KEK_SIZE = 32;
const SALT_SIZE = 16;
const MAX_EPOCH = 0xffff_ffff;

export interface WorkspaceKey {
  /** Which key generation this is. Packs declare it in the header's key_epoch. */
  epoch: number;
  /** 32 bytes. Never leaves the device unwrapped. */
  key: Uint8Array;
}

/**
 * Argon2id cost, stored per wrap rather than only per workspace.
 *
 * RFC 9106 section 4's second recommended option, measured at 766 ms here. That is the
 * right shape for something a person does once on a new device, and wrong for anything
 * on the editing path — which is why nothing on the editing path touches it.
 *
 * Every recovery wrap carries the parameters it was made with. A wrap whose cost lives
 * only in a separate workspace record becomes undecryptable the moment that record is
 * lost or truncated, and this is the file whose entire job is to work when other things
 * have gone wrong.
 */
export interface KdfParams {
  /** Memory cost in kibibytes. */
  m: number;
  /** Time cost, in passes. */
  t: number;
  /** Lanes. */
  p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { m: 65536, t: 3, p: 4 };

/**
 * Bounds on parameters read from a file.
 *
 * The ceiling is the load-bearing one: a wrap record in a shared folder is attacker-
 * controlled input, and a memory cost of a few terabytes would be a denial of service
 * that costs one line to write. The floor catches a wrap written by a misconfigured
 * build rather than an attacker, who cannot produce a valid tag anyway.
 */
const KDF_LIMITS = { minM: 8192, maxM: 1048576, minT: 1, maxT: 16, minP: 1, maxP: 16 };

export type KeyWrapProblem =
  /** The record does not parse, or a field is the wrong size. */
  | 'MALFORMED'
  /** Written by a newer Knowtion than this one. */
  | 'UNSUPPORTED_VERSION'
  /** A well-formed wrap belonging to a different workspace. */
  | 'WRONG_WORKSPACE'
  /** The wrong device key or the wrong phrase. The AEAD cannot tell which. */
  | 'WRONG_KEY';

export class KeyWrapError extends Error {
  readonly problem: KeyWrapProblem;

  constructor(problem: KeyWrapProblem, message: string) {
    super(message);
    this.name = 'KeyWrapError';
    this.problem = problem;
  }
}

function requireBytes(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new TypeError(`${name} must be exactly ${expected} bytes, received ${value.length}`);
  }
}

/**
 * Mint a workspace key.
 *
 * Platform randomness rather than the injected Random, for the reason keys.ts gives:
 * the determinism rule exists so the simulator can replay a failure from a seed, and a
 * reproducible workspace key would be no key at all.
 */
export function generateWorkspaceKey(epoch: number = FIRST_KEY_EPOCH): WorkspaceKey {
  if (!Number.isInteger(epoch) || epoch < FIRST_KEY_EPOCH || epoch > MAX_EPOCH) {
    throw new TypeError(`key epoch must be an integer in ${FIRST_KEY_EPOCH}..${MAX_EPOCH}`);
  }
  return { epoch, key: Uint8Array.from(randomBytes(WORKSPACE_KEY_SIZE)) };
}

/** The next generation: a fresh key under the next epoch, wrapped to whoever remains. */
export function rotateWorkspaceKey(current: WorkspaceKey): WorkspaceKey {
  return generateWorkspaceKey(current.epoch + 1);
}

const WRAP_KIND = { DEVICE: 1, RECOVERY: 2 } as const;

/**
 * Associated data common to both wrap kinds: 22 fixed-width bytes.
 *
 * Binding the kind stops a device wrap being presented as a recovery wrap. Binding the
 * epoch and workspace stops a wrap being moved between generations or between
 * workspaces — neither would reveal the key, but both would produce a confusing failure
 * far from its cause, and here failures happen when someone is already in trouble.
 */
function wrapAad(kind: number, epoch: number, workspaceId: Uint8Array): Uint8Array {
  const aad = new Uint8Array(22);
  const view = new DataView(aad.buffer);
  aad[0] = kind;
  aad[1] = KEY_WRAP_VERSION;
  view.setUint32(2, epoch, true);
  aad.set(workspaceId, 6);
  return aad;
}

const DEVICE_WRAP_INFO = new TextEncoder().encode('knowtion/device-key-wrap/v1');

/**
 * The key-encryption key for a device wrap.
 *
 * Both public keys go into the HKDF info, which is the standard KEM binding: it is what
 * stops one X25519 shared secret meaning anything under a different pair of keys.
 */
function deviceKek(
  shared: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const info = new Uint8Array(DEVICE_WRAP_INFO.length + 64);
  info.set(DEVICE_WRAP_INFO, 0);
  info.set(ephemeralPublicKey, DEVICE_WRAP_INFO.length);
  info.set(recipientPublicKey, DEVICE_WRAP_INFO.length + 32);
  return Uint8Array.from(hkdf(sha256, shared, undefined, info, KEK_SIZE));
}

/**
 * Seal the workspace key to a device's X25519 public key.
 *
 * Written by the device APPROVING the join, not by the device being approved — a
 * device cannot grant itself access, which is the property that makes pairing a human
 * decision rather than a race to write a file.
 */
export function wrapKeyToDevice(
  workspaceKey: WorkspaceKey,
  workspaceId: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  requireBytes('workspaceKey.key', workspaceKey.key, WORKSPACE_KEY_SIZE);
  requireBytes('workspaceId', workspaceId, 16);
  requireBytes('recipientPublicKey', recipientPublicKey, 32);

  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = Uint8Array.from(x25519.getPublicKey(ephemeralSecret));
  let shared: Uint8Array;
  try {
    shared = Uint8Array.from(x25519.getSharedSecret(ephemeralSecret, recipientPublicKey));
  } catch {
    // The library rejects low-order peer keys itself. Reaching here means the device
    // record carried a key that is not usable, so this is a bad record, not a bad key.
    throw new KeyWrapError('MALFORMED', 'the recipient public key is not a usable X25519 key');
  }

  const nonce = Uint8Array.from(randomBytes(NONCE_SIZE));
  const aad = wrapAad(WRAP_KIND.DEVICE, workspaceKey.epoch, workspaceId);
  const kek = deviceKek(shared, ephemeralPublicKey, recipientPublicKey);
  const sealed = xchacha20poly1305(kek, nonce, aad).encrypt(workspaceKey.key);

  return encodeSidecar({
    v: KEY_WRAP_VERSION,
    kind: 'device',
    epoch: workspaceKey.epoch,
    workspaceId,
    recipient: recipientPublicKey,
    ephemeral: ephemeralPublicKey,
    nonce,
    sealed,
  });
}

/** @throws KeyWrapError if the record is not ours, not readable, or not for this key. */
export function unwrapKeyFromDevice(
  record: Uint8Array,
  wrappingSecretKey: Uint8Array,
  workspaceId: Uint8Array,
): WorkspaceKey {
  requireBytes('workspaceId', workspaceId, 16);
  requireBytes('wrappingSecretKey', wrappingSecretKey, 32);
  const fields = openRecord(record, 'device', workspaceId);
  const ephemeralPublicKey = expectBytes(fields['ephemeral'], 32, 'ephemeral');
  const recipient = expectBytes(fields['recipient'], 32, 'recipient');

  // Derived rather than taken from the record, so a rewritten recipient field cannot
  // steer the derivation. Comparing them turns "not addressed to this device" into its
  // own message instead of an indistinguishable tag failure — which matters, because
  // one is normal during pairing and the other means something is wrong.
  const ourPublicKey = Uint8Array.from(x25519.getPublicKey(wrappingSecretKey));
  if (!equalBytes(ourPublicKey, recipient)) {
    throw new KeyWrapError('WRONG_KEY', 'this key wrap was sealed to a different device');
  }

  let shared: Uint8Array;
  try {
    shared = Uint8Array.from(x25519.getSharedSecret(wrappingSecretKey, ephemeralPublicKey));
  } catch {
    throw new KeyWrapError('MALFORMED', 'the wrap carries an unusable ephemeral key');
  }

  const kek = deviceKek(shared, ephemeralPublicKey, ourPublicKey);
  return {
    epoch: fields['epoch'] as number,
    key: openSealed(fields, kek, WRAP_KIND.DEVICE, workspaceId),
  };
}

/**
 * The key-encryption key for a recovery wrap.
 *
 * Derived from the phrase's 32 bytes of entropy, not from its words, so spacing and
 * casing cannot reach the KDF and a mistyped phrase fails its checksum in microseconds
 * rather than after a second of Argon2id.
 */
function recoveryKek(phrase: string, salt: Uint8Array, params: KdfParams): Uint8Array {
  const entropy = recoveryPhraseEntropy(phrase);
  return Uint8Array.from(
    argon2id(entropy, salt, { m: params.m, t: params.t, p: params.p, dkLen: KEK_SIZE }),
  );
}

/**
 * Seal the workspace key under the recovery phrase.
 *
 * @throws RecoveryPhraseError if the phrase does not check out — deliberately, because
 * writing a wrap under a phrase the user mistyped produces a file that looks correct
 * and can never be opened.
 */
export function wrapKeyToRecoveryPhrase(
  workspaceKey: WorkspaceKey,
  workspaceId: Uint8Array,
  phrase: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Uint8Array {
  requireBytes('workspaceKey.key', workspaceKey.key, WORKSPACE_KEY_SIZE);
  requireBytes('workspaceId', workspaceId, 16);
  checkParams(params);

  const salt = Uint8Array.from(randomBytes(SALT_SIZE));
  const nonce = Uint8Array.from(randomBytes(NONCE_SIZE));
  const aad = wrapAad(WRAP_KIND.RECOVERY, workspaceKey.epoch, workspaceId);
  const kek = recoveryKek(phrase, salt, params);
  const sealed = xchacha20poly1305(kek, nonce, aad).encrypt(workspaceKey.key);

  return encodeSidecar({
    v: KEY_WRAP_VERSION,
    kind: 'recovery',
    epoch: workspaceKey.epoch,
    workspaceId,
    salt,
    m: params.m,
    t: params.t,
    p: params.p,
    nonce,
    sealed,
  });
}

/** @throws KeyWrapError if the record is unreadable, or RecoveryPhraseError on a typo. */
export function unwrapKeyFromRecoveryPhrase(
  record: Uint8Array,
  phrase: string,
  workspaceId: Uint8Array,
): WorkspaceKey {
  requireBytes('workspaceId', workspaceId, 16);
  const fields = openRecord(record, 'recovery', workspaceId);
  const salt = expectBytes(fields['salt'], SALT_SIZE, 'salt');
  const params = readParams(fields);

  const kek = recoveryKek(phrase, salt, params);
  return {
    epoch: fields['epoch'] as number,
    key: openSealed(fields, kek, WRAP_KIND.RECOVERY, workspaceId),
  };
}

function checkParams(params: KdfParams): void {
  const { minM, maxM, minT, maxT, minP, maxP } = KDF_LIMITS;
  const ok =
    Number.isInteger(params.m) &&
    Number.isInteger(params.t) &&
    Number.isInteger(params.p) &&
    params.m >= minM &&
    params.m <= maxM &&
    params.t >= minT &&
    params.t <= maxT &&
    params.p >= minP &&
    params.p <= maxP;
  if (!ok) {
    throw new KeyWrapError(
      'MALFORMED',
      `key-derivation cost m=${String(params.m)} t=${String(params.t)} p=${String(params.p)} ` +
        `is outside the accepted range (m ${minM}..${maxM}, t ${minT}..${maxT}, p ${minP}..${maxP})`,
    );
  }
}

function readParams(fields: Record<string, unknown>): KdfParams {
  const params = { m: fields['m'], t: fields['t'], p: fields['p'] };
  if (
    typeof params.m !== 'number' ||
    typeof params.t !== 'number' ||
    typeof params.p !== 'number'
  ) {
    throw new KeyWrapError('MALFORMED', 'the wrap does not state its key-derivation cost');
  }
  const checked: KdfParams = { m: params.m, t: params.t, p: params.p };
  checkParams(checked);
  return checked;
}

function expectBytes(value: unknown, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new KeyWrapError('MALFORMED', `key wrap field ${field} must be ${length} bytes`);
  }
  return value;
}

/**
 * Parse a wrap record and check everything that can be checked without the key.
 *
 * The version check refuses a newer record rather than guessing at it, for the reason
 * FORMAT.md section 7 gives: a client that acts on a format it only partly understands
 * corrupts a workspace for every other client, and there is no server to notice.
 */
function openRecord(
  record: Uint8Array,
  kind: 'device' | 'recovery',
  workspaceId: Uint8Array,
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = decodeSidecar(record);
  } catch (error) {
    throw new KeyWrapError('MALFORMED', `key wrap could not be decoded: ${String(error)}`);
  }
  if (decoded === null || typeof decoded !== 'object') {
    throw new KeyWrapError('MALFORMED', 'key wrap is not an object');
  }
  const fields = decoded as Record<string, unknown>;

  const version = fields['v'];
  if (typeof version !== 'number' || version > KEY_WRAP_VERSION) {
    throw new KeyWrapError(
      'UNSUPPORTED_VERSION',
      `key wrap is version ${String(version)}; this build understands ${KEY_WRAP_VERSION}`,
    );
  }
  if (fields['kind'] !== kind) {
    throw new KeyWrapError(
      'MALFORMED',
      `expected a ${kind} key wrap, found ${String(fields['kind'])}`,
    );
  }

  const epoch = fields['epoch'];
  if (
    !Number.isInteger(epoch) ||
    (epoch as number) < FIRST_KEY_EPOCH ||
    (epoch as number) > MAX_EPOCH
  ) {
    throw new KeyWrapError('MALFORMED', `key wrap declares an impossible epoch ${String(epoch)}`);
  }

  if (!equalBytes(expectBytes(fields['workspaceId'], 16, 'workspaceId'), workspaceId)) {
    throw new KeyWrapError('WRONG_WORKSPACE', 'this key wrap belongs to a different workspace');
  }
  return fields;
}

/**
 * Open the sealed key.
 *
 * A tag failure is reported as WRONG_KEY without further detail, on purpose: a wrong
 * device key, a wrong phrase and a tampered record are indistinguishable to the AEAD
 * by design, and a message that guessed between them would sometimes be a lie told to
 * someone trying to recover their notes.
 */
function openSealed(
  fields: Record<string, unknown>,
  kek: Uint8Array,
  kind: number,
  workspaceId: Uint8Array,
): Uint8Array {
  const nonce = expectBytes(fields['nonce'], NONCE_SIZE, 'nonce');
  const sealed = expectBytes(fields['sealed'], WORKSPACE_KEY_SIZE + 16, 'sealed');
  const aad = wrapAad(kind, fields['epoch'] as number, workspaceId);
  try {
    return Uint8Array.from(xchacha20poly1305(kek, nonce, aad).decrypt(sealed));
  } catch {
    throw new KeyWrapError(
      'WRONG_KEY',
      'the key wrap did not open: the wrong key or phrase, or the file has been altered',
    );
  }
}
