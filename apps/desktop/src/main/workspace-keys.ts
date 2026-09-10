/**
 * This device's copy of the workspace keys, and the wrap files that grant them.
 *
 * ADR-0007 wraps the workspace key three ways. Two are objects in the workspace and
 * belong to the format package. The third is the operating system's keystore, and it is
 * this file: a local record, protected by the same SecretProtector that guards the
 * device's signing key, which MUST NOT ever be written into the sync folder.
 *
 * The record holds EVERY epoch this device has been granted rather than only the
 * newest. Rotation protects future writes; the history below it was written under older
 * epochs and stays readable only while their keys survive. Dropping an old epoch here
 * would turn a device revocation into silent data loss, which is the failure this whole
 * subsystem exists to avoid.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  KeyWrapError,
  keyringOf,
  toHex,
  unwrapKeyFromDevice,
  wrapKeyToDevice,
  wrapKeyToRecoveryPhrase,
  type DeviceKeys,
  type Keyring,
  type WorkspaceKey,
} from '@knowtion/format';
import type { StoragePath, StoragePort } from '@knowtion/sync';

import type { SecretProtector } from './identity.js';

const FILE = 'workspace-keys.json';

export interface WorkspaceKeyMaterial {
  /** Every epoch this device holds, ascending. Never pruned. */
  epochs: WorkspaceKey[];
  /** The epoch new packs are sealed under: always the highest one held. */
  current: number;
}

interface StoredKeys {
  v: number;
  current: number;
  /** Each epoch's key, protected then hex-encoded. */
  epochs: { epoch: number; key: string }[];
}

const STORED_VERSION = 1;

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

export function keyringFrom(material: WorkspaceKeyMaterial): Keyring {
  return keyringOf(...material.epochs);
}

/** The key new packs are sealed under. */
export function currentKey(material: WorkspaceKeyMaterial): WorkspaceKey {
  const key = material.epochs.find((e) => e.epoch === material.current);
  if (key === undefined) {
    throw new Error(`workspace keys name epoch ${material.current} as current but do not hold it`);
  }
  return key;
}

/** Sorted, deduplicated, with `current` recomputed as the highest epoch held. */
export function withEpoch(
  material: WorkspaceKeyMaterial | undefined,
  added: WorkspaceKey,
): WorkspaceKeyMaterial {
  const epochs = [...(material?.epochs ?? [])];
  if (!epochs.some((e) => e.epoch === added.epoch)) epochs.push(added);
  epochs.sort((a, b) => a.epoch - b.epoch);
  return { epochs, current: epochs[epochs.length - 1]!.epoch };
}

export async function readWorkspaceKeys(
  dataDir: string,
  protector: SecretProtector,
): Promise<WorkspaceKeyMaterial | undefined> {
  let stored: StoredKeys;
  try {
    stored = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as StoredKeys;
  } catch {
    // No keys yet. Distinct from "keys we cannot read", which is handled below: this
    // device simply has not been given any, and that is the ordinary first-run state.
    return undefined;
  }

  if (stored.v > STORED_VERSION) {
    // Written by a newer build. Guessing at it risks dropping an epoch we do not
    // understand, and a dropped epoch is unreadable history.
    throw new Error(
      `workspace keys are version ${stored.v}; this build understands ${STORED_VERSION}. ` +
        'Update Knowtion rather than continuing.',
    );
  }

  const epochs = stored.epochs.map(({ epoch, key }) => ({
    epoch,
    key: protector.unprotect(fromHex(key)),
  }));
  for (const { epoch, key } of epochs) {
    if (key.length !== 32) {
      throw new Error(`the stored key for epoch ${epoch} is ${key.length} bytes, not 32`);
    }
  }
  epochs.sort((a, b) => a.epoch - b.epoch);
  return { epochs, current: stored.current };
}

export async function writeWorkspaceKeys(
  dataDir: string,
  material: WorkspaceKeyMaterial,
  protector: SecretProtector,
): Promise<void> {
  const stored: StoredKeys = {
    v: STORED_VERSION,
    current: material.current,
    epochs: material.epochs.map(({ epoch, key }) => ({
      epoch,
      key: toHex(protector.protect(key)),
    })),
  };
  await writeFile(join(dataDir, FILE), `${JSON.stringify(stored, null, 2)}\n`);
}

export function deviceWrapPath(epoch: number, deviceHex: string): StoragePath {
  return `keys/${epoch}/${deviceHex}.wrap`;
}

export function recoveryWrapPath(epoch: number): StoragePath {
  return `keys/${epoch}/recovery.wrap`;
}

export interface WrapRecipient {
  deviceHex: string;
  wrappingPublicKey: Uint8Array;
}

/**
 * Grant an epoch to a set of devices, and to the recovery phrase.
 *
 * putIfAbsent rather than an overwrite, because FORMAT.md section 9 gives every path
 * one writer and two devices may approve the same joiner at once. Losing that race is
 * harmless: any valid wrap opens the same key, so the loser's work was redundant, not
 * lost. That is the same reasoning that makes content-addressed blobs safe.
 *
 * Devices already holding the epoch are simply skipped by putIfAbsent, so this can be
 * called on every sync without accumulating anything.
 */
export async function publishKeyWraps(
  storage: StoragePort,
  workspaceId: Uint8Array,
  key: WorkspaceKey,
  recipients: readonly WrapRecipient[],
  recoveryPhrase?: string,
): Promise<{ devices: number; recovery: boolean }> {
  let devices = 0;
  for (const recipient of recipients) {
    const wrap = wrapKeyToDevice(key, workspaceId, recipient.wrappingPublicKey);
    if (await storage.putIfAbsent(deviceWrapPath(key.epoch, recipient.deviceHex), wrap)) {
      devices++;
    }
  }

  let recovery = false;
  if (recoveryPhrase !== undefined) {
    const wrap = wrapKeyToRecoveryPhrase(key, workspaceId, recoveryPhrase);
    recovery = await storage.putIfAbsent(recoveryWrapPath(key.epoch), wrap);
  }
  return { devices, recovery };
}

/**
 * Collect any epoch this device has been granted but does not yet hold.
 *
 * Listing is advisory (FORMAT.md section 9), so a missing wrap means "not visible right
 * now", never "revoked". Nothing is ever removed here on the strength of an absence —
 * the worst a short listing can do is delay a device noticing a grant until the next
 * cycle.
 *
 * A wrap that fails to open is reported rather than thrown on. One unreadable grant
 * must not stop the others being collected, or a single damaged file in a synced folder
 * would keep a device locked out of every epoch.
 */
export async function collectGrantedKeys(
  storage: StoragePort,
  workspaceId: Uint8Array,
  deviceKeys: DeviceKeys,
  deviceHex: string,
  held: WorkspaceKeyMaterial | undefined,
): Promise<{ material: WorkspaceKeyMaterial | undefined; problems: string[] }> {
  const problems: string[] = [];
  let material = held;

  const objects = await storage.list('keys/');
  const suffix = `/${deviceHex}.wrap`;
  for (const object of objects) {
    if (!object.path.endsWith(suffix)) continue;

    const epoch = Number(object.path.slice('keys/'.length, object.path.length - suffix.length));
    // Only a sanity check on the name. The epoch that counts comes from the record
    // itself, which is authenticated; this one only decides whether to bother.
    if (!Number.isInteger(epoch) || epoch < 1) continue;
    if (material?.epochs.some((e) => e.epoch === epoch) === true) continue;

    const bytes = await storage.get(object.path);
    if (bytes === undefined) continue; // listed but not yet readable

    try {
      material = withEpoch(
        material,
        unwrapKeyFromDevice(bytes, deviceKeys.wrappingSecretKey, workspaceId),
      );
    } catch (error) {
      // A wrap sealed to another device is the ordinary case while pairing and is not
      // reported; anything else is worth a person seeing.
      if (error instanceof KeyWrapError && error.problem === 'WRONG_KEY') continue;
      problems.push(`${object.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { material, problems };
}
