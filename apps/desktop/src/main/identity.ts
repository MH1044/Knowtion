/**
 * This installation's identity: which workspace it belongs to, which log prefix it
 * owns, and the keys that prove it wrote what it wrote.
 *
 * Minted once and never regenerated. FORMAT.md section 9 gives every path exactly one
 * writer, so two installations sharing a device identifier would fork the pack chain;
 * and the registry record carrying the public keys is write-once, so the keys have to
 * exist before that record is written.
 *
 * The secret keys are handed to a protector before being stored. Where that protection
 * comes from is the host's business, not this module's — which is what lets it be
 * tested without Electron.
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateDeviceKeys, toHex, type DeviceKeys } from '@knowtion/format';

export interface Identity {
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  /** Distinguishes this device's operations inside a CRDT document. */
  peerId: bigint;
  keys: DeviceKeys;
  label: string;
}

/**
 * Wraps and unwraps secret material at rest.
 *
 * A pass-through implementation is a legitimate configuration — on a machine with no OS
 * keystore there is nothing better available — but it must be a deliberate choice made
 * where the platform is known, never a silent default here.
 */
export interface SecretProtector {
  protect(plaintext: Uint8Array): Uint8Array;
  unprotect(sealed: Uint8Array): Uint8Array;
  /** Shown to the user when protection is weaker than they would expect. */
  readonly description: string;
}

export const passthroughProtector: SecretProtector = {
  protect: (plaintext) => plaintext,
  unprotect: (sealed) => sealed,
  description: 'stored without OS protection',
};

const FILE = 'identity.json';

interface StoredIdentity {
  workspaceId: string;
  deviceId: string;
  peerId: string;
  label: string;
  /** Both secret keys, protected then hex-encoded. */
  secrets: string;
  signingPublicKey: string;
  wrappingPublicKey: string;
}

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

export async function loadOrCreateIdentity(
  dataDir: string,
  protector: SecretProtector,
  defaultLabel: string,
): Promise<Identity> {
  const path = join(dataDir, FILE);
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as StoredIdentity;
    const secrets = protector.unprotect(fromHex(stored.secrets));
    if (secrets.length !== 64) {
      throw new Error('identity secrets are the wrong length');
    }
    return {
      workspaceId: fromHex(stored.workspaceId),
      deviceId: fromHex(stored.deviceId),
      peerId: BigInt(stored.peerId),
      label: stored.label,
      keys: {
        signingSecretKey: secrets.slice(0, 32),
        wrappingSecretKey: secrets.slice(32, 64),
        signingPublicKey: fromHex(stored.signingPublicKey),
        wrappingPublicKey: fromHex(stored.wrappingPublicKey),
      },
    };
  } catch {
    // No identity yet, or one this build cannot read. Minting a fresh one is correct
    // for the first case. For the second it is the only option available, and it is
    // why the workspace identifier is stored beside it: a device that has lost its
    // identity has to be re-approved rather than silently trusted.
  }

  const keys = generateDeviceKeys();
  const identity: Identity = {
    workspaceId: Uint8Array.from(randomBytes(16)),
    deviceId: Uint8Array.from(randomBytes(16)),
    // Loro peer ids are u64; six bytes keeps it comfortably inside the range.
    peerId: BigInt(`0x${randomBytes(6).toString('hex')}`),
    keys,
    label: defaultLabel,
  };
  await saveIdentity(dataDir, identity, protector);
  return identity;
}

export async function saveIdentity(
  dataDir: string,
  identity: Identity,
  protector: SecretProtector,
): Promise<void> {
  const secrets = new Uint8Array(64);
  secrets.set(identity.keys.signingSecretKey, 0);
  secrets.set(identity.keys.wrappingSecretKey, 32);

  const stored: StoredIdentity = {
    workspaceId: toHex(identity.workspaceId),
    deviceId: toHex(identity.deviceId),
    peerId: identity.peerId.toString(),
    label: identity.label,
    secrets: toHex(protector.protect(secrets)),
    signingPublicKey: toHex(identity.keys.signingPublicKey),
    wrappingPublicKey: toHex(identity.keys.wrappingPublicKey),
  };
  await writeFile(join(dataDir, FILE), `${JSON.stringify(stored, null, 2)}\n`);
}

/**
 * Adopt another workspace's identifier, keeping this device's own keys.
 *
 * Used when pairing: the device stays itself, but now belongs somewhere else. The
 * device identifier is regenerated because the log prefix must be unique within the
 * workspace being joined, and nothing guarantees it was.
 */
export async function adoptWorkspace(
  dataDir: string,
  identity: Identity,
  workspaceId: Uint8Array,
  protector: SecretProtector,
): Promise<Identity> {
  const adopted: Identity = {
    ...identity,
    workspaceId,
    deviceId: Uint8Array.from(randomBytes(16)),
  };
  await saveIdentity(dataDir, adopted, protector);
  return adopted;
}
