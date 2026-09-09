import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../memory-storage.js';
import { PackStore, packPath, parsePackPath } from '../pack-store.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);

const hexA = 'aa'.repeat(16);
const hexB = 'bb'.repeat(16);
/** The page hierarchy's reserved document identifier. */
const TREE = '0'.repeat(32);

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

    expect(second!.seq).toBe(2);
    // The second pack holds one operation, not the whole history.
    expect(second!.bytes).toBeLessThan(first!.bytes + 100);

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
    expect(result.rejected[0]!.code).toBe('TOO_SHORT');
    expect(result.rejected[0]!.path).toBe(packPath(hexA, TREE, 1));
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
    expect(result.rejected[0]!.code).toBe('BAD_HEADER_CRC');
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
      a.write(`key${i}`, String(i));
      expected[`key${i}`] = String(i);
      storage.duringWrite = () => {
        a.write(`mid${i}`, `m${i}`);
        expected[`mid${i}`] = `m${i}`;
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
