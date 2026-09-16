/**
 * NodeStorage when the filesystem cannot hard-link, or when `link()` fails oddly.
 *
 * FAT32, exFAT and some network redirectors refuse `link()`, and the adapter then falls
 * back to the pre-atomic `writeFile(..., 'wx')` — remembering the refusal for its own
 * lifetime and reporting `crashSafe = false` so the product can say so. There is no such
 * volume on CI, so the module boundary is mocked here rather than the behaviour left
 * untested. This is the honest option: the alternative is a test that passes on NTFS and
 * proves nothing about the code path a memory stick takes.
 *
 * Kept in its own file because `vi.mock` is hoisted per module: the real-filesystem
 * tests in node-storage.test.ts must see the genuine `link`.
 */
import { link, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeStorage } from '../node-storage.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

const PACK = 'd/aa/000000000001.kpack';
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
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
  const dir = await mkdtemp(join(tmpdir(), `knowtion-fallback-${label}-`));
  roots.push(dir);
  return dir;
}

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

const mockedLink = vi.mocked(link);

beforeEach(() => {
  mockedLink.mockReset();
});

describe('when the filesystem cannot hard-link', () => {
  it.each(['EPERM', 'ENOSYS', 'EXDEV', 'EMLINK'])(
    'falls back on %s, remembers it, and reports the write is not crash safe',
    async (code) => {
      mockedLink.mockRejectedValue(errno(code));
      const dir = await root(code.toLowerCase());
      const s = new NodeStorage(dir);

      expect(await s.putIfAbsent(PACK, bytes('written directly'))).toBe(true);
      expect(text(await s.get(PACK))).toBe('written directly');
      expect(s.crashSafe).toBe(false);

      // The old create-if-absent semantic still holds on the fallback path.
      expect(await s.putIfAbsent(PACK, bytes('again'))).toBe(false);
      expect(text(await s.get(PACK))).toBe('written directly');
      expect(await files(dir)).toEqual([PACK]);

      // "Remember it for the life of this adapter": one failed syscall, not one per pack.
      expect(mockedLink).toHaveBeenCalledTimes(1);
    },
  );
});

describe('when link() fails for a reason that is not a missing capability', () => {
  it('rejects, publishes nothing, cleans its temporary, and stays crash safe', async () => {
    // EACCES is a permissions problem on this folder, not a statement about the
    // filesystem. Latching `crashSafe` to false here would misreport every later write.
    mockedLink.mockRejectedValueOnce(errno('EACCES'));
    const dir = await root('eacces');
    const s = new NodeStorage(dir);

    await expect(s.putIfAbsent(PACK, bytes('never lands'))).rejects.toThrow(/EACCES/);
    expect(await s.get(PACK)).toBeUndefined();
    expect(await files(dir)).toEqual([]);
    expect(s.crashSafe).toBe(true);

    // And the adapter is not wedged: the next attempt publishes normally.
    expect(await s.putIfAbsent(PACK, bytes('lands now'))).toBe(true);
    expect(text(await s.get(PACK))).toBe('lands now');
  });

  it('treats EEXIST at link time as "already there", with the temporary cleaned up', async () => {
    // The canonical file appeared between our open() and our link(): another writer
    // won. That is the ordinary loser's outcome, not an error.
    mockedLink.mockRejectedValueOnce(errno('EEXIST'));
    const dir = await root('eexist');
    const s = new NodeStorage(dir);

    expect(await s.putIfAbsent(PACK, bytes('lost the race'))).toBe(false);
    expect(await files(dir)).toEqual([]);
    expect(s.crashSafe).toBe(true);
  });
});
