/**
 * NodeStorage's atomic publish, on a real filesystem.
 *
 * The crash soak (packages/simulator/src/crash.ts) proves the engine survives every
 * outcome a torn or unacknowledged write can leave behind — against an in-memory model
 * of the disk. This file is the other half: that the real adapter only ever produces the
 * outcomes that model contains. A temporary written and fsynced, then published by
 * `link()` in one step, means the canonical pack path can hold a complete pack or
 * nothing, never a prefix.
 *
 * Runs on whatever `os.tmpdir()` is: NTFS on Windows, ext4 or APFS elsewhere. All of them
 * hard-link. Filesystems that cannot are covered by node-storage.fallback.test.ts.
 */
import { mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { afterAll, describe, expect, it } from 'vitest';

import { NodeStorage } from '../node-storage.js';
import { PackStore, packPath } from '../pack-store.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);
const HEX_A = 'aa'.repeat(16);
const TREE = '0'.repeat(32);

const PACK = 'd/aa/000000000001.kpack';
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

/** Unwraps a lookup the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function root(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `knowtion-node-${label}-`));
  roots.push(dir);
  return dir;
}

/** Every file under the root, as forward-slashed relative paths. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();
}

describe('NodeStorage publishes a pack atomically', () => {
  it('publishes the exact bytes at the canonical path and leaves no temporary behind', async () => {
    const dir = await root('publish');
    const s = new NodeStorage(dir);

    expect(await s.putIfAbsent(PACK, bytes('pack one'))).toBe(true);
    expect(text(await s.get(PACK))).toBe('pack one');
    // The only file is the pack. A `.tmp` left beside it would be listed by a cloud
    // client and puzzled over by a person; `list()` hides them, the disk should not need it.
    expect(await files(dir)).toEqual([PACK]);
  });

  it('reports crashSafe once a real hard link has succeeded', async () => {
    // Not merely the default value: the getter must reflect that `link()` genuinely
    // worked on this filesystem, because a memory stick would flip it.
    const dir = await root('crashsafe');
    const s = new NodeStorage(dir);
    await s.putIfAbsent(PACK, bytes('x'));
    expect(s.crashSafe).toBe(true);
  });

  it('a second put reports the object exists and touches neither bytes nor mtime', async () => {
    const dir = await root('second');
    const s = new NodeStorage(dir);
    await s.putIfAbsent(PACK, bytes('first'));
    const before = await stat(join(dir, ...PACK.split('/')));

    expect(await s.putIfAbsent(PACK, bytes('second'))).toBe(false);

    const after = await stat(join(dir, ...PACK.split('/')));
    expect(text(await s.get(PACK))).toBe('first');
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await files(dir)).toEqual([PACK]);
  });

  it('two concurrent puts to one path: exactly one wins, and the file is one intact payload', async () => {
    // `link()` failing with EEXIST is what makes create-if-absent honest under a race.
    // The loser must not have clobbered the winner, and no half-and-half file can exist.
    const dir = await root('race');
    const s = new NodeStorage(dir);
    const a = bytes('payload from the first writer, long enough to matter');
    const b = bytes('payload from the second writer, also long enough');

    const results = await Promise.all([s.putIfAbsent(PACK, a), s.putIfAbsent(PACK, b)]);
    expect(results.filter((r) => r).length).toBe(1);

    const stored = text(await s.get(PACK));
    expect([text(a), text(b)]).toContain(stored);
    expect(await files(dir)).toEqual([PACK]);
  });

  it('never lists an orphaned temporary, and later puts are unaffected by it', async () => {
    const dir = await root('orphan');
    const s = new NodeStorage(dir);
    await s.putIfAbsent(PACK, bytes('one'));
    await writeFile(join(dir, 'd', 'aa', '000000000002.kpack.999-7.tmp'), 'orphan');

    expect((await s.list('d/aa')).map((o) => o.path)).toEqual([PACK]);
    expect(await s.putIfAbsent('d/aa/000000000002.kpack', bytes('two'))).toBe(true);
    expect((await s.list('d/aa')).map((o) => o.path)).toEqual([PACK, 'd/aa/000000000002.kpack']);
  });
});

describe('a torn pack on a real disk is repaired end to end', () => {
  /** One device publishes one pack, then the file is cut as a kill would leave it. */
  async function tornAtSeqOne(keepBytes: number) {
    const dir = await root(`torn-${String(keepBytes)}`);
    const storage = new NodeStorage(dir);
    const store = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    doc.getMap('notes').set('first', 'value');
    doc.commit();
    const pushed = must(await store.push(doc), 'a pack');
    await truncate(join(dir, ...pushed.path.split('/')), keepBytes);
    return { dir, path: pushed.path };
  }

  it.each([
    ['a zero-byte file, as a kill between open and write leaves', 0],
    ['a header cut in half', 90],
    ['a complete header with no payload', 180],
  ])('recovers from %s through NodeStorage and PackStore together', async (_label, keepBytes) => {
    // pack-store.test.ts proves this against MemoryStorage.truncate. This proves the real
    // adapter's delete-then-link repair produces the same outcome on a real directory.
    const { dir, path } = await tornAtSeqOne(keepBytes);
    expect(path).toBe(packPath(HEX_A, TREE, 1));

    const storage = new NodeStorage(dir);
    const restarted = new PackStore({ storage, workspaceId: WORKSPACE, deviceId: DEVICE_A });
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    const first = await restarted.pull(doc);
    expect(first.rejected.map((r) => r.path)).toEqual([path]);

    doc.getMap('notes').set('after', 'crash');
    doc.commit();
    const pushed = await restarted.push(doc);
    expect(pushed?.path).toBe(path);

    // A second device reads the whole folder back clean.
    const reader = new PackStore({
      storage: new NodeStorage(dir),
      workspaceId: WORKSPACE,
      deviceId: DEVICE_B,
    });
    const fresh = new LoroDoc();
    fresh.setPeerId(9n);
    const result = await reader.pull(fresh);
    expect(result.rejected).toEqual([]);
    expect(fresh.getMap('notes').toJSON()).toEqual({ after: 'crash' });

    // Exactly one file at the canonical path, and nothing half-published beside it.
    expect(await files(dir)).toEqual([path, `d/${HEX_A}/${TREE}/head.json`]);
  });
});
