/**
 * The contract every storage adapter must satisfy.
 *
 * Written now rather than earlier because a second implementation finally exists: a
 * contract with one implementation only tests your assumptions against themselves.
 *
 * The assertions are the ones that matter to an append-only, single-writer log. Where a
 * real provider is weaker than a local disk, the contract asserts the weaker behaviour,
 * so code written against it cannot be accidentally correct only on a filesystem.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MemoryStorage } from '../memory-storage.js';
import { NodeStorage } from '../node-storage.js';
import type { StoragePort } from '../storage-port.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

/** Unwraps a storage read the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

const temporaryRoots: string[] = [];
afterAll(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

async function temporaryStorage(label: string): Promise<NodeStorage> {
  const root = await mkdtemp(join(tmpdir(), `knowtion-${label}-`));
  temporaryRoots.push(root);
  return new NodeStorage(root);
}

const adapters: [name: string, make: () => Promise<StoragePort>][] = [
  ['MemoryStorage', () => Promise.resolve(new MemoryStorage())],
  ['NodeStorage', () => temporaryStorage('contract')],
];

describe.each(adapters)('storage contract: %s', (_name, make) => {
  it('round-trips an object', async () => {
    const s = await make();
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('hello'));
    expect(text(await s.get('d/aa/000000000001.kpack'))).toBe('hello');
  });

  it('returns undefined for a missing object rather than throwing', async () => {
    // Absence is a normal state during sync, not an error. Throwing would turn "this
    // pack has not arrived yet" into a crash.
    const s = await make();
    expect(await s.get('d/aa/000000000009.kpack')).toBeUndefined();
  });

  it('putIfAbsent creates once, then reports the object already exists', async () => {
    const s = await make();
    expect(await s.putIfAbsent('d/aa/000000000001.kpack', bytes('first'))).toBe(true);
    expect(await s.putIfAbsent('d/aa/000000000001.kpack', bytes('second'))).toBe(false);
    // Critically, the original content is untouched. Packs are immutable.
    expect(text(await s.get('d/aa/000000000001.kpack'))).toBe('first');
  });

  it('putOwn overwrites, because a single-writer path cannot lose another device data', async () => {
    const s = await make();
    await s.putOwn('d/aa/head.json', bytes('{"seq":1}'));
    await s.putOwn('d/aa/head.json', bytes('{"seq":2}'));
    expect(text(await s.get('d/aa/head.json'))).toBe('{"seq":2}');
  });

  it('creates intermediate directories without being asked', async () => {
    const s = await make();
    await s.putIfAbsent('blobs/ab/abcdef.kblob', bytes('binary'));
    expect(text(await s.get('blobs/ab/abcdef.kblob'))).toBe('binary');
  });

  it('lists by prefix without leaking a sibling prefix', async () => {
    const s = await make();
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('a1'));
    await s.putIfAbsent('d/aa/000000000002.kpack', bytes('a2'));
    await s.putIfAbsent('d/bb/000000000001.kpack', bytes('b1'));

    const listed = await s.list('d/aa');
    expect(listed.map((o) => o.path).sort()).toEqual([
      'd/aa/000000000001.kpack',
      'd/aa/000000000002.kpack',
    ]);
    expect(listed.every((o) => o.size > 0)).toBe(true);
  });

  it('lists an empty prefix as empty rather than failing', async () => {
    const s = await make();
    expect(await s.list('d/nothing-here')).toEqual([]);
  });

  it('deletes, and deleting something absent is not an error', async () => {
    // Delete must be idempotent: a retry after a timeout must not fail the sync cycle.
    const s = await make();
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('x'));
    await s.delete('d/aa/000000000001.kpack');
    expect(await s.get('d/aa/000000000001.kpack')).toBeUndefined();
    await expect(s.delete('d/aa/000000000001.kpack')).resolves.toBeUndefined();
  });

  it('returns an independent copy, so a caller cannot mutate stored bytes', async () => {
    const s = await make();
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('original'));
    const first = must(await s.get('d/aa/000000000001.kpack'), 'the stored bytes');
    first[0] = 0x00;
    expect(text(await s.get('d/aa/000000000001.kpack'))).toBe('original');
  });

  it('stores bytes verbatim, including nulls, CRLF and high bytes', async () => {
    // Packs are binary. An adapter that round-trips through a string corrupts them,
    // and on Windows a naive text write would also rewrite 0x0a as 0x0d0a.
    const s = await make();
    const binary = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80, 0x7f]);
    await s.putIfAbsent('d/aa/000000000003.kpack', binary);
    expect(Array.from(must(await s.get('d/aa/000000000003.kpack'), 'the stored bytes'))).toEqual(
      Array.from(binary),
    );
  });
});

describe('NodeStorage specifics', () => {
  it('refuses a path that escapes the storage root', async () => {
    const s = await temporaryStorage('escape');
    await expect(s.putIfAbsent('../outside.kpack', bytes('nope'))).rejects.toThrow(/escapes/);
  });

  it('ignores in-flight temporary files when listing', async () => {
    // putOwn writes beside its target before renaming. A concurrent listing must not
    // report the temporary as if it were a real object.
    const s = await temporaryStorage('tmp');
    await s.putIfAbsent('d/aa/000000000001.kpack.tmp', bytes('in flight'));
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('real'));
    expect((await s.list('d/aa')).map((o) => o.path)).toEqual(['d/aa/000000000001.kpack']);
  });
});

describe('the settle rule', () => {
  /** A controllable clock, so the test never waits on real time. */
  function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
    let value = start;
    return { now: () => value, advance: (ms) => (value += ms) };
  }

  it('withholds a file until two sightings agree', async () => {
    // A cloud client materialises a file in stages: it can appear at size zero and gain
    // content later. Reading it then yields a truncated pack, which verification would
    // report as damage when nothing is actually wrong.
    const root = await mkdtemp(join(tmpdir(), 'knowtion-settle-'));
    temporaryRoots.push(root);
    const time = clock();
    const s = new NodeStorage(root, { settle: { ms: 250, now: time.now } });

    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('content'));
    expect(await s.list('d/aa'), 'first sighting is withheld').toEqual([]);

    time.advance(300);
    expect((await s.list('d/aa')).map((o) => o.path)).toEqual(['d/aa/000000000001.kpack']);
  });

  it('restarts the clock when the file is still changing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowtion-settle-grow-'));
    temporaryRoots.push(root);
    const time = clock();
    const s = new NodeStorage(root, { settle: { ms: 250, now: time.now } });

    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('partial'));
    await s.list('d/aa');

    // The writer is still going, so the file changes between sightings.
    await s.putOwn('d/aa/000000000001.kpack', bytes('partial and then some more'));
    time.advance(300);
    expect(await s.list('d/aa'), 'changed, so not settled').toEqual([]);

    time.advance(300);
    expect(await s.list('d/aa')).toHaveLength(1);
  });

  it('is off by default, because a local-only log has one writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowtion-nosettle-'));
    temporaryRoots.push(root);
    const s = new NodeStorage(root);
    await s.putIfAbsent('d/aa/000000000001.kpack', bytes('content'));
    expect(await s.list('d/aa')).toHaveLength(1);
  });
});
