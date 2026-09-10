import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateWorkspaceKey,
  rotateWorkspaceKey,
  toHex,
  unwrapKeyFromRecoveryPhrase,
} from '@knowtion/format';
import { MemoryStorage } from '@knowtion/sync';

import { passthroughProtector, type SecretProtector } from '../identity.js';
import {
  collectGrantedKeys,
  currentKey,
  deviceWrapPath,
  keyringFrom,
  publishKeyWraps,
  readWorkspaceKeys,
  recoveryWrapPath,
  withEpoch,
  writeWorkspaceKeys,
} from '../workspace-keys.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowtion-keys-'));
  dirs.push(dir);
  return dir;
}

/** Stands in for the OS keystore, so the stored bytes are visibly not the key. */
const xorProtector: SecretProtector = {
  description: 'test protector',
  protect: (plain) => plain.map((b) => b ^ 0x5a),
  unprotect: (sealed) => sealed.map((b) => b ^ 0x5a),
};

describe('the local key store', () => {
  it('reports no keys rather than failing on a device that has none', async () => {
    expect(await readWorkspaceKeys(await temp(), passthroughProtector)).toBeUndefined();
  });

  it('round-trips every epoch it holds', async () => {
    const dir = await temp();
    const first = generateWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    const material = withEpoch(withEpoch(undefined, first), second);

    await writeWorkspaceKeys(dir, material, xorProtector);
    const read = await readWorkspaceKeys(dir, xorProtector);

    expect(read?.epochs).toEqual([first, second]);
    expect(read?.current).toBe(second.epoch);
    expect(currentKey(read!)).toEqual(second);
  });

  it('protects the key at rest', async () => {
    // The OS-keychain wrap, which is the only one of ADR-0007's three that never leaves
    // the device. A key readable straight out of the file would make it decorative.
    const dir = await temp();
    const key = generateWorkspaceKey();
    await writeWorkspaceKeys(dir, withEpoch(undefined, key), xorProtector);
    const onDisk = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'workspace-keys.json'), 'utf8'),
    );
    expect(onDisk).not.toContain(toHex(key.key));
  });

  it('keeps epochs sorted and never drops one', async () => {
    // Dropping an old epoch would make every pack written under it unreadable, which
    // turns a device revocation into silent data loss.
    const a = generateWorkspaceKey();
    const b = rotateWorkspaceKey(a);
    const c = rotateWorkspaceKey(b);
    const material = withEpoch(withEpoch(withEpoch(undefined, c), a), b);
    expect(material.epochs.map((e) => e.epoch)).toEqual([1, 2, 3]);
    expect(material.current).toBe(3);
    expect([...keyringFrom(material).keys()].sort()).toEqual([1, 2, 3]);
  });

  it('ignores a repeated grant of an epoch it already holds', async () => {
    const key = generateWorkspaceKey();
    expect(withEpoch(withEpoch(undefined, key), key).epochs).toHaveLength(1);
  });

  it('refuses a store written by a newer build rather than dropping what it cannot read', async () => {
    const dir = await temp();
    await writeFile(
      join(dir, 'workspace-keys.json'),
      JSON.stringify({ v: 99, current: 1, epochs: [] }),
    );
    await expect(readWorkspaceKeys(dir, passthroughProtector)).rejects.toThrow(/version 99/);
  });
});

describe('granting an epoch through wrap files', () => {
  const alice = generateDeviceKeys();
  const bob = generateDeviceKeys();
  const hexA = 'aa'.repeat(16);
  const hexB = 'bb'.repeat(16);

  it('writes one wrap per device and one for the recovery phrase', async () => {
    const storage = new MemoryStorage();
    const key = generateWorkspaceKey();
    const phrase = generateRecoveryPhrase();

    const written = await publishKeyWraps(
      storage,
      WORKSPACE,
      key,
      [
        { deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey },
        { deviceHex: hexB, wrappingPublicKey: bob.wrappingPublicKey },
      ],
      phrase,
    );

    expect(written).toEqual({ devices: 2, recovery: true });
    expect(await storage.get(deviceWrapPath(key.epoch, hexA))).toBeDefined();
    expect(await storage.get(deviceWrapPath(key.epoch, hexB))).toBeDefined();

    const recovery = await storage.get(recoveryWrapPath(key.epoch));
    expect(unwrapKeyFromRecoveryPhrase(recovery!, phrase, WORKSPACE).key).toEqual(key.key);
  });

  it('is idempotent, so it can run on every sync without accumulating', async () => {
    // Two devices may approve the same joiner at once. Losing that race is harmless
    // because any valid wrap opens the same key, so the loser's work was redundant.
    const storage = new MemoryStorage();
    const key = generateWorkspaceKey();
    const recipients = [{ deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey }];

    expect((await publishKeyWraps(storage, WORKSPACE, key, recipients)).devices).toBe(1);
    expect((await publishKeyWraps(storage, WORKSPACE, key, recipients)).devices).toBe(0);
    expect((await storage.list('keys/')).length).toBe(1);
  });

  it('collects only the epochs granted to this device', async () => {
    const storage = new MemoryStorage();
    const first = generateWorkspaceKey();
    const second = rotateWorkspaceKey(first);

    // Alice is granted both epochs; Bob only the first, as if revoked before rotation.
    await publishKeyWraps(storage, WORKSPACE, first, [
      { deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey },
      { deviceHex: hexB, wrappingPublicKey: bob.wrappingPublicKey },
    ]);
    await publishKeyWraps(storage, WORKSPACE, second, [
      { deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey },
    ]);

    const forAlice = await collectGrantedKeys(storage, WORKSPACE, alice, hexA, undefined);
    expect(forAlice.problems).toEqual([]);
    expect(forAlice.material?.epochs.map((e) => e.epoch)).toEqual([1, 2]);
    expect(forAlice.material?.current).toBe(2);
    expect(currentKey(forAlice.material!).key).toEqual(second.key);

    // A revoked device keeps what it already had and gains nothing further. Rotation
    // protects future writes only; it cannot reach back into what Bob already read.
    const forBob = await collectGrantedKeys(storage, WORKSPACE, bob, hexB, undefined);
    expect(forBob.material?.epochs.map((e) => e.epoch)).toEqual([1]);
  });

  it('reports a damaged wrap without giving up on the others', async () => {
    // One bad file in a synced folder must not lock a device out of every epoch.
    const storage = new MemoryStorage();
    const first = generateWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    const recipients = [{ deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey }];
    await publishKeyWraps(storage, WORKSPACE, first, recipients);
    await publishKeyWraps(storage, WORKSPACE, second, recipients);

    await storage.putOwn(deviceWrapPath(first.epoch, hexA), new Uint8Array(40).fill(0xff));

    const result = await collectGrantedKeys(storage, WORKSPACE, alice, hexA, undefined);
    expect(result.material?.epochs.map((e) => e.epoch)).toEqual([2]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(deviceWrapPath(first.epoch, hexA));
  });

  it('does not re-read an epoch it already holds', async () => {
    const storage = new MemoryStorage();
    const key = generateWorkspaceKey();
    await publishKeyWraps(storage, WORKSPACE, key, [
      { deviceHex: hexA, wrappingPublicKey: alice.wrappingPublicKey },
    ]);
    const held = withEpoch(undefined, key);
    const result = await collectGrantedKeys(storage, WORKSPACE, alice, hexA, held);
    expect(result.material).toBe(held);
  });
});
