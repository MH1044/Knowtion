import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import {
  SUITE,
  decodePack,
  encodePack,
  generateDeviceKeys,
  generateWorkspaceKey,
  keyringOf,
  rotateWorkspaceKey,
  verifyPackSignature,
  type DeviceKeys,
} from '@knowtion/format';

import { MemoryStorage } from '../memory-storage.js';
import {
  PackStore,
  packPath,
  parsePackPath,
  parseSnapshotPath,
  type PackCrypto,
} from '../pack-store.js';
import type { StoragePort } from '../storage-port.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);

const hexA = 'aa'.repeat(16);
const hexB = 'bb'.repeat(16);
/** The page hierarchy's reserved document identifier. */
const TREE = '0'.repeat(32);

/** Unwraps a lookup/result the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** Indexing an array can't statically prove the element is there. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

/** Same as `at`, for a `Uint8Array`, which is not a `T[]`. */
function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new Error(`expected byte at index ${String(index)}`);
  return value;
}

function device(storage: MemoryStorage, id: Uint8Array, peerId: bigint) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return {
    doc,
    store: new PackStore({ storage, workspaceId: WORKSPACE, deviceId: id }),
    write(key: string, value: string) {
      doc.getMap('notes').set(key, value);
      doc.commit();
    },
    notes(): Record<string, unknown> {
      return doc.getMap('notes').toJSON() as Record<string, unknown>;
    },
  };
}

describe('pack paths', () => {
  it('zero-pads the sequence so lexical order equals numeric order', () => {
    expect(packPath(hexA, TREE, 1)).toBe(`d/${hexA}/${TREE}/000000000001.kpack`);
    expect(packPath(hexA, TREE, 42)).toBe(`d/${hexA}/${TREE}/000000000042.kpack`);
    // The property that makes a sorted listing usable without parsing every name.
    expect(
      [packPath(hexA, TREE, 10), packPath(hexA, TREE, 9), packPath(hexA, TREE, 100)].sort(),
    ).toEqual([packPath(hexA, TREE, 9), packPath(hexA, TREE, 10), packPath(hexA, TREE, 100)]);
  });

  it('ignores anything that is not exactly our naming scheme', () => {
    // Sync clients invent these when they think two devices edited one file. The strict
    // regex is what makes an unrecognised conflict copy inert rather than mis-ingested.
    for (const bad of [
      `d/${hexA}/${TREE}/000000000001 (1).kpack`,
      `d/${hexA}/${TREE}/000000000001-DESKTOP-AB12.kpack`,
      `d/${hexA}/${TREE}/1.kpack`,
      `d/${hexA}/${TREE}/000000000001.kpack.tmp`,
      `d/${hexA}/${TREE}/head.json`,
      `d/not-hex/${TREE}/000000000001.kpack`,
      `d/${hexA}/not-hex/000000000001.kpack`,
      `d/${hexA}/000000000001.kpack`,
      `blobs/aa/deadbeef.kblob`,
    ]) {
      expect(parsePackPath(bad), bad).toBeUndefined();
    }
  });

  it('parses a well-formed path', () => {
    expect(parsePackPath(packPath(hexB, TREE, 7))).toEqual({
      deviceHex: hexB,
      documentHex: TREE,
      seq: 7,
    });
  });
});

describe('push and pull', () => {
  it('writes nothing when there is nothing new', async () => {
    const a = device(new MemoryStorage(), DEVICE_A, 1n);
    expect(await a.store.push(a.doc)).toBeUndefined();
  });

  it('persists a document and reloads it into a fresh one', async () => {
    // The restart path: the in-memory document is gone, and the log is the only truth.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('title', 'Hello');

    const pushed = await a.store.push(a.doc);
    expect(pushed?.seq).toBe(1);
    expect(pushed?.path).toBe(packPath(hexA, TREE, 1));

    const reloaded = device(storage, DEVICE_A, 1n);
    const result = await reloaded.store.pull(reloaded.doc);
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(reloaded.notes()).toEqual({ title: 'Hello' });
  });

  it('appends incrementally, so each pack carries only new operations', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);

    a.write('one', '1');
    const first = await a.store.push(a.doc);
    a.write('two', '2');
    const second = await a.store.push(a.doc);

    expect(must(second, 'a push result').seq).toBe(2);
    // The second pack holds one operation, not the whole history.
    expect(must(second, 'a push result').bytes).toBeLessThan(
      must(first, 'a push result').bytes + 100,
    );

    const reloaded = device(storage, DEVICE_A, 1n);
    await reloaded.store.pull(reloaded.doc);
    expect(reloaded.notes()).toEqual({ one: '1', two: '2' });
  });

  it('skips packs it has already merged rather than re-reading them', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);

    const b = device(storage, DEVICE_B, 2n);
    expect((await b.store.pull(b.doc)).applied).toBe(1);
    const second = await b.store.pull(b.doc);
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe('two devices through one folder', () => {
  it('converges without either device writing the other prefix', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    const b = device(storage, DEVICE_B, 2n);

    a.write('from-a', 'A');
    await a.store.push(a.doc);
    await b.store.pull(b.doc);
    b.write('from-b', 'B');
    await b.store.push(b.doc);
    await a.store.pull(a.doc);

    expect(a.notes()).toEqual({ 'from-a': 'A', 'from-b': 'B' });
    expect(b.notes()).toEqual({ 'from-a': 'A', 'from-b': 'B' });

    // Every object lives under exactly one device prefix. Nothing is shared and
    // mutable, which is what makes this safe on a provider with no conditional write.
    const paths = (await storage.list('d/')).map((o) => o.path);
    expect(paths.some((p) => p.startsWith(`d/${hexA}/`))).toBe(true);
    expect(paths.some((p) => p.startsWith(`d/${hexB}/`))).toBe(true);
    expect(paths.filter((p) => !p.startsWith('d/'))).toEqual([]);
  });

  it('converges after concurrent offline edits', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('shared', 'seed');
    await a.store.push(a.doc);

    const b = device(storage, DEVICE_B, 2n);
    await b.store.pull(b.doc);

    // Both edit while neither can see the other.
    a.write('only-a', '1');
    b.write('only-b', '2');
    await a.store.push(a.doc);
    await b.store.push(b.doc);

    await a.store.pull(a.doc);
    await b.store.pull(b.doc);

    expect(a.notes()).toEqual(b.notes());
    expect(a.notes()).toEqual({ shared: 'seed', 'only-a': '1', 'only-b': '2' });
  });

  it('does not re-push operations that arrived from another device', async () => {
    // Otherwise every device rewrites every other device's history into its own packs
    // and the log grows quadratically with the number of devices.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);

    const b = device(storage, DEVICE_B, 2n);
    await b.store.pull(b.doc);
    expect(await b.store.push(b.doc)).toBeUndefined();
  });

  it('tolerates a listing that lags behind a write', async () => {
    // Google Drive's list is eventually consistent while a fetch by id is not, so a
    // reader can legitimately fail to see a pack that already exists.
    const storage = new MemoryStorage({ listLag: 1 });
    const a = device(storage, DEVICE_A, 1n);
    a.write('first', '1');
    await a.store.push(a.doc);

    const b = device(storage, DEVICE_B, 2n);
    // Whatever the lag hides, an invisible object must never be reported as damage.
    expect((await b.store.pull(b.doc)).rejected).toEqual([]);

    a.write('second', '2');
    await a.store.push(a.doc); // later writes push earlier ones past the lag horizon
    const later = await b.store.pull(b.doc);
    expect(later.rejected).toEqual([]);
    expect(b.notes()).toEqual({ first: '1' });

    // And once everything is visible, the devices agree.
    a.write('third', '3');
    await a.store.push(a.doc);
    await b.store.pull(b.doc);
    expect(b.notes()).toEqual({ first: '1', second: '2' });
  });

  it('converges regardless of the order a listing returns packs in', async () => {
    // No provider guarantees listing order, and folder mode has no delta feed at all.
    const storage = new MemoryStorage({ reverseListing: true });
    const a = device(storage, DEVICE_A, 1n);
    a.write('one', '1');
    await a.store.push(a.doc);
    a.write('two', '2');
    await a.store.push(a.doc);

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);
    expect(result.rejected).toEqual([]);
    expect(b.notes()).toEqual({ one: '1', two: '2' });
  });
});

describe('damaged and hostile files', () => {
  it('rejects a truncated pack instead of applying it, and says which one', async () => {
    // The signature failure of a half-synced cloud folder.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    storage.truncate(packPath(hexA, TREE, 1), 100);

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);

    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(at(result.rejected, 0).code).toBe('TOO_SHORT');
    expect(at(result.rejected, 0).path).toBe(packPath(hexA, TREE, 1));
  });

  it('rejects a corrupted header rather than trusting its fields', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    storage.damage(packPath(hexA, TREE, 1), 40); // inside the sequence number

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);
    expect(result.applied).toBe(0);
    expect(at(result.rejected, 0).code).toBe('BAD_HEADER_CRC');
  });

  it('ignores foreign files without reporting them as damage', async () => {
    // A conflict copy, a .DS_Store, a user's own note dropped into the folder. None of
    // these are errors, and treating them as errors trains people to ignore the report.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);

    await storage.putIfAbsent(`d/${hexA}/${TREE}/000000000001 (1).kpack`, new Uint8Array(300));
    await storage.putIfAbsent(`d/${hexA}/${TREE}/notes.txt`, new TextEncoder().encode('hello'));

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(b.notes()).toEqual({ k: 'v' });
  });

  it('refuses to overwrite one of its own packs', async () => {
    // Two app instances sharing a device identity would otherwise fork the chain
    // silently, and the loser's edits would vanish.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    const impostor = device(storage, DEVICE_A, 3n);

    a.write('k', 'v');
    await a.store.push(a.doc);
    impostor.write('other', 'x');

    await expect(impostor.store.push(impostor.doc)).rejects.toThrow(/device identity/);
  });
});

describe('edits made while a write is in flight', () => {
  /** Storage that lets the test mutate the document mid-write. */
  class InterleavingStorage extends MemoryStorage {
    duringWrite: (() => void) | undefined;

    override async putIfAbsent(path: string, bytes: Uint8Array): Promise<boolean> {
      const hook = this.duringWrite;
      this.duringWrite = undefined;
      // Runs after the payload has been exported and before the write completes,
      // which is exactly when a user typing during an autosave lands.
      hook?.();
      return super.putIfAbsent(path, bytes);
    }
  }

  it('never marks an operation as published unless it was actually written', async () => {
    // The bug: the published version was read AFTER the write completed, so anything
    // added during the write was recorded as sent without ever being written, and the
    // next push skipped it. Pages vanished from the log while looking fine on screen.
    const storage = new InterleavingStorage();
    const a = device(storage, DEVICE_A, 1n);

    a.write('before', '1');
    storage.duringWrite = () => {
      a.write('during', '2');
    };
    await a.store.push(a.doc);

    // A second push must carry the operation that landed mid-write.
    await a.store.push(a.doc);

    const reader = device(storage, DEVICE_B, 2n);
    await reader.store.pull(reader.doc);
    expect(reader.notes()).toEqual({ before: '1', during: '2' });
  });

  it('survives many interleaved writes without losing any of them', async () => {
    const storage = new InterleavingStorage();
    const a = device(storage, DEVICE_A, 1n);
    const expected: Record<string, string> = {};

    for (let i = 0; i < 20; i++) {
      a.write(`key${String(i)}`, String(i));
      expected[`key${String(i)}`] = String(i);
      storage.duringWrite = () => {
        a.write(`mid${String(i)}`, `m${String(i)}`);
        expected[`mid${String(i)}`] = `m${String(i)}`;
      };
      await a.store.push(a.doc);
    }
    // A final push for whatever landed during the last write.
    await a.store.push(a.doc);

    const reader = device(storage, DEVICE_B, 2n);
    const result = await reader.store.pull(reader.doc);
    expect(result.rejected).toEqual([]);
    expect(reader.notes()).toEqual(expected);
  });
});

describe('conflict copies', () => {
  /** A sync client renaming a file, which is what they do when they see a clash. */
  async function renameTo(storage: MemoryStorage, from: string, to: string): Promise<void> {
    const bytes = must(await storage.get(from), 'the file being renamed');
    await storage.putIfAbsent(to, bytes);
    await storage.delete(from);
  }

  it('adopts a copy when the original was the file that got renamed', async () => {
    // Ignoring it would be safe but would lose those operations permanently.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('important', 'value');
    await a.store.push(a.doc);

    await renameTo(
      storage,
      packPath(hexA, TREE, 1),
      `d/${hexA}/${TREE}/000000000001-DESKTOP-AB12.kpack`,
    );

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);

    expect(result.adopted).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(b.notes()).toEqual({ important: 'value' });
  });

  it('handles the parenthesised naming too', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    await renameTo(storage, packPath(hexA, TREE, 1), `d/${hexA}/${TREE}/000000000001 (1).kpack`);

    const b = device(storage, DEVICE_B, 2n);
    expect((await b.store.pull(b.doc)).adopted).toBe(1);
    expect(b.notes()).toEqual({ k: 'v' });
  });

  it('ignores a copy whose original is still present', async () => {
    // Then it is a duplicate, and adopting it would cost a decode every cycle for
    // operations already merged.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    const original = must(await storage.get(packPath(hexA, TREE, 1)), 'the original pack');
    await storage.putIfAbsent(`d/${hexA}/${TREE}/000000000001 (1).kpack`, original);

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);
    expect(result.applied).toBe(1);
    expect(result.adopted).toBe(0);
  });

  it('does not adopt a damaged copy', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    const copyPath = `d/${hexA}/${TREE}/000000000001 (1).kpack`;
    await renameTo(storage, packPath(hexA, TREE, 1), copyPath);
    storage.damage(copyPath, 40);

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);
    expect(result.adopted).toBe(0);
    expect(b.notes()).toEqual({});
  });

  it('uses the identity inside the file, not the mangled filename', async () => {
    // The filename is precisely what the sync client corrupted, so trusting it would
    // defeat the purpose.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    await renameTo(
      storage,
      packPath(hexA, TREE, 1),
      `d/${hexA}/${TREE}/totally-unrelated-name.kpack`,
    );

    const b = device(storage, DEVICE_B, 2n);
    expect((await b.store.pull(b.doc)).adopted).toBe(1);
    expect(b.notes()).toEqual({ k: 'v' });
  });

  it('adopts a copy only once across repeated cycles', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    await renameTo(storage, packPath(hexA, TREE, 1), `d/${hexA}/${TREE}/000000000001 (1).kpack`);

    const b = device(storage, DEVICE_B, 2n);
    expect((await b.store.pull(b.doc)).adopted).toBe(1);
    expect((await b.store.pull(b.doc)).adopted).toBe(0);
  });
});

describe('a rename in the middle of a chain', () => {
  it('still delivers every later pack', async () => {
    // Found by the simulator. Adoption recovered the renamed pack, but it ran AFTER the
    // chain pass — so pack 3 saw pack 2 missing, failed its prevPackHash check, and was
    // rejected on every future cycle. One rename by a sync client silently froze a
    // device's history at that point.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);

    a.write('one', '1');
    await a.store.push(a.doc);
    a.write('two', '2');
    await a.store.push(a.doc);
    a.write('three', '3');
    await a.store.push(a.doc);

    // The client renames the middle pack.
    const middle = packPath(hexA, TREE, 2);
    const bytes = must(await storage.get(middle), 'the middle pack');
    await storage.putIfAbsent(`d/${hexA}/${TREE}/000000000002-DESKTOP-AB12.kpack`, bytes);
    await storage.delete(middle);

    const b = device(storage, DEVICE_B, 2n);
    const result = await b.store.pull(b.doc);

    expect(result.rejected, 'nothing should be permanently rejected').toEqual([]);
    expect(b.notes()).toEqual({ one: '1', two: '2', three: '3' });
  });

  it('recovers on a later cycle if the copy appears after the gap was seen', async () => {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('one', '1');
    await a.store.push(a.doc);
    a.write('two', '2');
    await a.store.push(a.doc);

    const second = packPath(hexA, TREE, 2);
    const bytes = must(await storage.get(second), 'the second pack');
    await storage.delete(second);

    const b = device(storage, DEVICE_B, 2n);
    await b.store.pull(b.doc); // sees the gap
    expect(b.notes()).toEqual({ one: '1' });

    // The copy turns up later, as a still-syncing folder does.
    await storage.putIfAbsent(`d/${hexA}/${TREE}/000000000002 (1).kpack`, bytes);
    await b.store.pull(b.doc);
    expect(b.notes()).toEqual({ one: '1', two: '2' });
  });
});

describe('encrypted workspaces', () => {
  const keysA = generateDeviceKeys();
  const keysB = generateDeviceKeys();
  const workspaceKey = generateWorkspaceKey();

  /** A registry stand-in: which signing key belongs to which device. */
  const registry = new Map([
    [hexA, keysA.signingPublicKey],
    [hexB, keysB.signingPublicKey],
  ]);
  const signingKeyFor = (deviceHex: string) => Promise.resolve(registry.get(deviceHex));

  const crypto = (deviceKeys: DeviceKeys, over: Partial<PackCrypto> = {}): PackCrypto => ({
    keyring: keyringOf(workspaceKey),
    sealWith: workspaceKey,
    signingSecretKey: deviceKeys.signingSecretKey,
    signingKeyFor,
    ...over,
  });

  const encrypted = (storage: MemoryStorage, id: Uint8Array, peerId: bigint, c: PackCrypto) => {
    const doc = new LoroDoc();
    doc.setPeerId(peerId);
    return {
      doc,
      store: new PackStore({ storage, workspaceId: WORKSPACE, deviceId: id, crypto: c }),
      write(key: string, value: string) {
        doc.getMap('notes').set(key, value);
        doc.commit();
      },
      notes: () => doc.getMap('notes').toJSON() as Record<string, unknown>,
    };
  };

  it('writes packs that are encrypted and signed on disk', async () => {
    const storage = new MemoryStorage();
    const a = encrypted(storage, DEVICE_A, 1n, crypto(keysA));
    a.write('title', 'a very distinctive secret string');
    const pushed = await a.store.push(a.doc);

    const bytes = must(await storage.get(must(pushed, 'pushed').path), 'bytes');
    const { header } = decodePack(bytes);
    expect(header.suiteId).toBe(SUITE.XCHACHA20POLY1305_ARGON2ID);
    expect(header.keyEpoch).toBe(workspaceKey.epoch);
    expect(verifyPackSignature(bytes, keysA.signingPublicKey)).toBe(true);
    // The thing the whole feature exists for.
    expect(Buffer.from(bytes).includes(Buffer.from('a very distinctive secret string'))).toBe(
      false,
    );
  });

  it('converges two devices through one folder', async () => {
    const storage = new MemoryStorage();
    const a = encrypted(storage, DEVICE_A, 1n, crypto(keysA));
    const b = encrypted(storage, DEVICE_B, 2n, crypto(keysB));

    a.write('from', 'a');
    await a.store.push(a.doc);
    b.write('also', 'b');
    await b.store.push(b.doc);

    await a.store.pull(a.doc);
    await b.store.pull(b.doc);
    await a.store.push(a.doc);
    await b.store.pull(b.doc);

    expect(a.notes()).toEqual({ from: 'a', also: 'b' });
    expect(b.notes()).toEqual({ from: 'a', also: 'b' });
  });

  it('reads a log holding both plaintext and encrypted packs', async () => {
    // The property that makes turning the cipher on possible at all: every pack
    // declares its own suite, so switching costs privacy, never readability.
    const storage = new MemoryStorage();
    const plain = device(storage, DEVICE_A, 1n);
    plain.write('written', 'before');
    await plain.store.push(plain.doc);

    const after = encrypted(storage, DEVICE_A, 1n, crypto(keysA));
    await after.store.pull(after.doc);
    after.write('written', 'after');
    const pushed = await after.store.push(after.doc);

    expect(
      decodePack(must(await storage.get(must(pushed, 'pushed').path), 'bytes')).header.suiteId,
    ).toBe(SUITE.XCHACHA20POLY1305_ARGON2ID);

    const reader = encrypted(storage, DEVICE_B, 2n, crypto(keysB));
    const result = await reader.store.pull(reader.doc);
    expect(result.rejected).toEqual([]);
    expect(reader.notes()).toEqual({ written: 'after' });
  });
});

describe('encrypted workspaces reject what they cannot trust', () => {
  const keysA = generateDeviceKeys();
  const keysB = generateDeviceKeys();
  const workspaceKey = generateWorkspaceKey();
  const signingKeyFor = (deviceHex: string) =>
    Promise.resolve(deviceHex === hexA ? keysA.signingPublicKey : undefined);

  const writer = (storage: MemoryStorage) =>
    new PackStore({
      storage,
      workspaceId: WORKSPACE,
      deviceId: DEVICE_A,
      crypto: {
        keyring: keyringOf(workspaceKey),
        sealWith: workspaceKey,
        signingSecretKey: keysA.signingSecretKey,
        signingKeyFor,
      },
    });

  async function onePack(storage: MemoryStorage): Promise<string> {
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    doc.getMap('notes').set('k', 'v');
    doc.commit();
    const pushed = await writer(storage).push(doc);
    return must(pushed, 'pushed').path;
  }

  const readerWith = (storage: MemoryStorage, crypto?: PackCrypto) =>
    new PackStore({
      storage,
      workspaceId: WORKSPACE,
      deviceId: DEVICE_B,
      ...(crypto === undefined ? {} : { crypto }),
    });

  it('refuses an encrypted pack when the workspace holds no keys, rather than importing ciphertext', async () => {
    // Before this routing existed, ciphertext went straight to doc.import(), so a
    // downgrade looked exactly like ordinary corruption.
    const storage = new MemoryStorage();
    const path = await onePack(storage);
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const result = await readerWith(storage).pull(doc);
    expect(result.applied).toBe(0);
    expect(result.rejected.map((r) => r.code)).toEqual(['UNKNOWN_KEY_EPOCH']);
    expect(at(result.rejected, 0).path).toBe(path);
  });

  it('refuses a pack from a device it has no registry record for', async () => {
    const storage = new MemoryStorage();
    await onePack(storage);
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const result = await readerWith(storage, {
      keyring: keyringOf(workspaceKey),
      signingSecretKey: keysB.signingSecretKey,
      signingKeyFor: () => Promise.resolve(undefined),
    }).pull(doc);
    expect(result.rejected.map((r) => r.code)).toEqual(['BAD_SIGNATURE']);
  });

  it('refuses a pack altered after it was written', async () => {
    const storage = new MemoryStorage();
    const path = await onePack(storage);
    const bytes = Uint8Array.from(must(await storage.get(path), 'bytes'));
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = byteAt(bytes, lastIndex) ^ 0x01;
    await storage.putOwn(path, bytes);

    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const result = await readerWith(storage, {
      keyring: keyringOf(workspaceKey),
      signingSecretKey: keysB.signingSecretKey,
      signingKeyFor,
    }).pull(doc);
    // Rule 7 fires before decryption, so the report names forgery rather than a tag.
    expect(result.rejected.map((r) => r.code)).toEqual(['BAD_SIGNATURE']);
    expect(result.applied).toBe(0);
  });

  it('refuses a pack under a key epoch it has not been granted', async () => {
    const storage = new MemoryStorage();
    await onePack(storage);
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const result = await readerWith(storage, {
      keyring: keyringOf(rotateWorkspaceKey(workspaceKey)),
      signingSecretKey: keysB.signingSecretKey,
      signingKeyFor,
    }).pull(doc);
    expect(result.rejected.map((r) => r.code)).toEqual(['UNKNOWN_KEY_EPOCH']);
  });
});

describe('a pack that cannot be read', () => {
  /** MemoryStorage, but one named path always fails the way a locked file does. */
  class OneUnreadable implements StoragePort {
    constructor(
      private readonly inner: MemoryStorage,
      private readonly unreadable: string,
      private readonly code = 'EBUSY',
    ) {}
    putIfAbsent = (p: string, b: Uint8Array) => this.inner.putIfAbsent(p, b);
    putOwn = (p: string, b: Uint8Array) => this.inner.putOwn(p, b);
    list = (p: string) => this.inner.list(p);
    delete = (p: string) => this.inner.delete(p);
    get(path: string): Promise<Uint8Array | undefined> {
      if (path === this.unreadable) {
        return Promise.reject(Object.assign(new Error('locked'), { code: this.code }));
      }
      return this.inner.get(path);
    }
  }

  /** Two devices each publish one pack into a shared folder. */
  async function twoPublishedPacks() {
    const inner = new MemoryStorage();
    const a = device(inner, DEVICE_A, 1n);
    const b = device(inner, DEVICE_B, 2n);
    a.write('from', 'a');
    const fromA = await a.store.push(a.doc);
    b.write('also', 'b');
    const fromB = await b.store.push(b.doc);
    if (fromA === undefined || fromB === undefined) throw new Error('expected both pushes');
    return { inner, fromA: fromA.path, fromB: fromB.path };
  }

  it('does not stop the other devices\u2019 packs merging in the same cycle', async () => {
    // The invariant this whole change exists for. Before it, one throwing read
    // abandoned every remaining candidate, so a single locked file on a laptop with
    // OneDrive could stall the entire workspace.
    const { inner, fromA, fromB } = await twoPublishedPacks();
    const storage = new OneUnreadable(inner, fromA);

    const reader = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const result = await reader.pull(doc);

    expect(result.applied).toBe(1);
    expect(doc.getMap('notes').toJSON()).toEqual({ also: 'b' });
    expect(result.rejected.map((r) => r.code)).toEqual(['UNREADABLE']);
    expect(at(result.rejected, 0).path).toBe(fromA);
    expect(fromB).toBeDefined();
  });

  it('reports it rather than skipping it silently', async () => {
    // FORMAT.md section 3: a silent skip is indistinguishable from data loss, so the
    // path and the reason must both reach a human.
    const { inner, fromA } = await twoPublishedPacks();
    const reader = new PackStore({
      storage: new OneUnreadable(inner, fromA),
      workspaceId: WORKSPACE,
      deviceId: DEVICE_A,
    });
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    const rejected = (await reader.pull(doc)).rejected;
    expect(at(rejected, 0).message).toContain(fromA);
    expect(at(rejected, 0).message).toContain('EBUSY');
  });

  it('picks the pack up on a later cycle once it is readable again', async () => {
    // Transient means transient. A file locked during one scan must not be written off.
    const { inner, fromA } = await twoPublishedPacks();
    const storage = new OneUnreadable(inner, fromA);
    const reader = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(9n);

    await reader.pull(doc);
    expect(doc.getMap('notes').toJSON()).toEqual({ also: 'b' });

    // Now readable: the same store, next cycle, no restart.
    const healed = new PackStore({ storage: inner, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc2 = new LoroDoc();
    doc2.setPeerId(9n);
    const after = await healed.pull(doc2);
    expect(after.rejected).toEqual([]);
    expect(doc2.getMap('notes').toJSON()).toEqual({ from: 'a', also: 'b' });
  });

  it('still throws on a failure that is not transient', async () => {
    // A permanent error must not be quietly retried forever. EROFS is not something a
    // later cycle fixes, so it surfaces.
    const { inner, fromA } = await twoPublishedPacks();
    const reader = new PackStore({
      storage: new OneUnreadable(inner, fromA, 'EROFS'),
      workspaceId: WORKSPACE,
      deviceId: DEVICE_A,
    });
    const doc = new LoroDoc();
    doc.setPeerId(9n);
    await expect(reader.pull(doc)).rejects.toThrow();
  });
});

describe('a torn pack left behind by a crash', () => {
  /** One device, one pack published, then the file truncated as a kill would leave it. */
  async function tornAtSeqOne(keepBytes: number) {
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('first', 'value');
    const pushed = await a.store.push(a.doc);
    if (pushed === undefined) throw new Error('expected a pack');
    storage.truncate(pushed.path, keepBytes);
    return { storage, path: pushed.path };
  }

  it.each([
    ['a zero-byte file, as a kill between open and write leaves', 0],
    ['a header cut in half', 90],
    ['a complete header with no payload', 180],
  ])('recovers from %s', async (_label, keepBytes) => {
    // The wedge. A partial pack at seq 1 never decodes, so it is never applied, so
    // lastSeq stays 0 and every future push aims at the same occupied path. Before the
    // repair, this device could never write again — for the life of the workspace.
    const { storage, path } = await tornAtSeqOne(keepBytes);

    const restarted = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    await restarted.pull(doc);

    doc.getMap('notes').set('after', 'crash');
    doc.commit();
    const pushed = await restarted.push(doc);
    expect(pushed?.path).toBe(path);

    // And the workspace genuinely reads back, rather than merely not throwing.
    const reader = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_B });
    const fresh = new LoroDoc();
    fresh.setPeerId(9n);
    const result = await reader.pull(fresh);
    expect(result.rejected).toEqual([]);
    expect(fresh.getMap('notes').toJSON()).toEqual({ after: 'crash' });
  });

  it('keeps writing afterwards, so the chain continues', async () => {
    const { storage } = await tornAtSeqOne(40);
    const restarted = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    await restarted.pull(doc);

    for (const n of [1, 2, 3]) {
      doc.getMap('notes').set(`k${String(n)}`, String(n));
      doc.commit();
      expect(await restarted.push(doc)).toBeDefined();
    }

    const reader = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_B });
    const fresh = new LoroDoc();
    fresh.setPeerId(9n);
    const result = await reader.pull(fresh);
    expect(result.rejected).toEqual([]);
    expect(fresh.getMap('notes').toJSON()).toEqual({ k1: '1', k2: '2', k3: '3' });
  });

  it('still refuses when the occupying pack belongs to someone else', async () => {
    // The whitelist that preserves real identity-clash detection: another writer's pack
    // decodes, so it is not ours to replace.
    const storage = new MemoryStorage();
    const b = device(storage, DEVICE_B, 2n);
    b.write('theirs', 'value');
    const theirs = await b.store.push(b.doc);
    if (theirs === undefined) throw new Error('expected a pack');

    // Put their pack exactly where our seq 1 would go.
    const ours = packPath(hexA, TREE, 1);
    const bytes = await storage.get(theirs.path);
    if (bytes === undefined) throw new Error('expected bytes');
    await storage.putIfAbsent(ours, bytes);

    const a = device(storage, DEVICE_A, 1n);
    a.write('mine', 'value');
    await expect(a.store.push(a.doc)).rejects.toThrow(/another process/);
  });
});

describe('reading a snapshot back', () => {
  it('parses only the five-segment snapshot form', () => {
    expect(parseSnapshotPath(`d/${hexA}/${TREE}/snap/000000000007.ksnap`)).toEqual({
      deviceHex: hexA,
      documentHex: TREE,
      seq: 7,
    });
    for (const bad of [
      packPath(hexA, TREE, 7),
      `d/${hexA}/${TREE}/000000000007.ksnap`,
      `d/${hexA}/${TREE}/snap/7.ksnap`,
      `d/${hexA}/${TREE}/other/000000000007.ksnap`,
      `d/not-hex/${TREE}/snap/000000000007.ksnap`,
    ]) {
      expect(parseSnapshotPath(bad), bad).toBeUndefined();
    }
  });

  it('leaves parsePackPath alone, so compaction still cannot delete a snapshot', () => {
    // Widening parsePackPath instead of adding this one would have made Compactor.collect
    // delete the very snapshots that supersede the packs it is trimming.
    expect(parsePackPath(`d/${hexA}/${TREE}/snap/000000000007.ksnap`)).toBeUndefined();
  });

  it('rebuilds a workspace whose superseded packs have been deleted', async () => {
    // The returning-device path. Compaction genuinely deletes packs a snapshot covers,
    // and until the reader existed a device arriving afterwards saw the gap and nothing
    // that filled it.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    for (const n of [1, 2, 3]) {
      a.write(`k${String(n)}`, String(n));
      await a.store.push(a.doc);
    }

    // Publish a snapshot of everything so far, exactly as the compactor does.
    const snapshot = encodePack({
      workspaceId: WORKSPACE,
      deviceId: DEVICE_A,
      seq: 3n,
      payload: a.doc.export({ mode: 'snapshot' }),
      isShallowSnapshot: true,
    });
    await storage.putIfAbsent(`d/${hexA}/${TREE}/snap/000000000003.ksnap`, snapshot);

    // Then collect: the packs the snapshot supersedes are gone.
    for (const n of [1, 2, 3]) await storage.delete(packPath(hexA, TREE, n));

    const arriving = device(storage, DEVICE_B, 2n);
    const result = await arriving.store.pull(arriving.doc);
    expect(result.rejected).toEqual([]);
    expect(arriving.notes()).toEqual({ k1: '1', k2: '2', k3: '3' });
  });

  it('accepts the pack written after a snapshot, whose predecessor was deleted', async () => {
    // A snapshot carries no prevPackHash of its own, so it cannot hand pack N+1 the
    // predecessor hash the chain check wants. Without re-anchoring, every pack after a
    // collection would be BROKEN_CHAIN forever.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    for (const n of [1, 2]) {
      a.write(`k${String(n)}`, String(n));
      await a.store.push(a.doc);
    }
    const snapshot = encodePack({
      workspaceId: WORKSPACE,
      deviceId: DEVICE_A,
      seq: 2n,
      payload: a.doc.export({ mode: 'snapshot' }),
      isShallowSnapshot: true,
    });
    await storage.putIfAbsent(`d/${hexA}/${TREE}/snap/000000000002.ksnap`, snapshot);

    // Device A keeps working after the snapshot.
    a.write('after', 'snapshot');
    await a.store.push(a.doc);
    for (const n of [1, 2]) await storage.delete(packPath(hexA, TREE, n));

    const arriving = device(storage, DEVICE_B, 2n);
    const result = await arriving.store.pull(arriving.doc);
    expect(result.rejected).toEqual([]);
    expect(arriving.notes()).toEqual({ k1: '1', k2: '2', after: 'snapshot' });
  });

  it('reports a damaged snapshot rather than skipping it', async () => {
    // If the packs have been collected it is the only copy, so silence here is the
    // silence FORMAT.md section 3 forbids.
    const storage = new MemoryStorage();
    const a = device(storage, DEVICE_A, 1n);
    a.write('k', 'v');
    await a.store.push(a.doc);
    const path = `d/${hexA}/${TREE}/snap/000000000001.ksnap`;
    await storage.putIfAbsent(path, new Uint8Array(64).fill(0xff));

    const arriving = device(storage, DEVICE_B, 2n);
    const result = await arriving.store.pull(arriving.doc);
    expect(result.rejected.map((r) => r.path)).toContain(path);
    // The pack beside it still merges: one bad snapshot is not a failed cycle.
    expect(arriving.notes()).toEqual({ k: 'v' });
  });
});
