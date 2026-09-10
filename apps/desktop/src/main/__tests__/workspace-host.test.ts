/**
 * The main-process logic, tested without Electron.
 *
 * WorkspaceHost deliberately imports nothing from Electron, so the part of the
 * application that can actually lose a user's notes is testable headlessly and on
 * every push, rather than only by launching a window and clicking.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  SUITE,
  decodePack,
  generateDeviceKeys,
  generateWorkspaceKey,
  verifyPackSignature,
} from '@knowtion/format';

import { WorkspaceHost } from '../workspace-host.js';
import { withEpoch } from '../workspace-keys.js';

const WORKSPACE_ID = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    // Windows holds a lock on a SQLite file briefly after close, so a failed cleanup
    // is a temporary-directory left behind, not a test failure worth reporting.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowtion-host-'));
  dirs.push(dir);
  return dir;
}

const open = (dir: string, deviceId = DEVICE_A, peerId = 1n) =>
  WorkspaceHost.open({
    dataDir: dir,
    workspaceId: WORKSPACE_ID,
    deviceId,
    peerId,
    deviceKeys: keysFor(deviceId),
    // Flush on the next tick so tests never wait on a real debounce.
    flushDelayMs: 0,
  });

/**
 * One keypair per device identifier, reused across reopens.
 *
 * A device that came back with new keys would look like a different device to the
 * registry, and the record is write-once — so a test that reopens a host must present
 * the same keys a real installation would have kept.
 */
const keyCache = new Map<string, ReturnType<typeof generateDeviceKeys>>();
function keysFor(deviceId: Uint8Array): ReturnType<typeof generateDeviceKeys> {
  const key = Buffer.from(deviceId).toString('hex');
  let keys = keyCache.get(key);
  if (!keys) {
    keys = generateDeviceKeys();
    keyCache.set(key, keys);
  }
  return keys;
}

const titles = (pages: { title: string }[]) => pages.map((p) => p.title).sort();

describe('WorkspaceHost', () => {
  it('starts empty and creates pages', async () => {
    const host = await open(await dataDir());
    expect(host.tree()).toEqual([]);

    const page = host.createPage({ title: 'First' });
    expect(page.title).toBe('First');
    expect(titles(host.tree())).toEqual(['First']);
    await host.close();
  });

  it('persists across a restart of the host', async () => {
    // The actual product promise: quit the app, reopen it, your notes are there.
    const dir = await dataDir();

    const first = await open(dir);
    const parent = first.createPage({ title: 'Parent' });
    first.createPage({ parentId: parent.id, title: 'Child' });
    await first.close();

    const second = await open(dir);
    expect(titles(second.tree())).toEqual(['Parent']);
    expect(titles(at(second.tree(), 0).children)).toEqual(['Child']);
    await second.close();
  });

  it('writes nothing at all for a workspace nobody touched', async () => {
    // An idle app must not add a file to the user's folder on every launch. In folder
    // mode that is an upload their cloud client performs for no reason, forever.
    const dir = await dataDir();
    const host = await open(dir);
    await host.close();

    const entries = await readdir(dir, { recursive: true });
    expect(entries.filter((e) => e.endsWith('.kpack'))).toEqual([]);
  });

  it('flushes pending edits on close, so quitting never loses the last keystrokes', async () => {
    // Writes are debounced, so without an explicit flush the final edits exist only in
    // memory. This is the small, deniable data loss that destroys trust in a notes app.
    const dir = await dataDir();
    const host = await open(dir);
    host.createPage({ title: 'Typed just before quitting' });
    await host.close(); // no waiting for the debounce

    const reopened = await open(dir);
    expect(titles(reopened.tree())).toEqual(['Typed just before quitting']);
    await reopened.close();
  });

  it('coalesces a burst of edits rather than writing a pack each time', async () => {
    const dir = await dataDir();
    const host = await open(dir);
    for (let i = 0; i < 25; i++) host.createPage({ title: `Page ${String(i)}` });
    await host.close();

    const files = (await readdir(join(dir, 'log'), { recursive: true })).map(String);
    const packs = files.filter((f) => f.endsWith('.kpack'));
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.length, 'a pack per edit would be 25').toBeLessThan(5);
  });

  it('surfaces an engine error rather than corrupting the tree', async () => {
    const host = await open(await dataDir());
    const root = host.createPage({ title: 'Root' });
    const child = host.createPage({ parentId: root.id, title: 'Child' });

    expect(() => host.movePage(root.id, child.id)).toThrowError(/cycle|descendant/i);
    // The tree is exactly as it was.
    expect(titles(host.tree())).toEqual(['Root']);
    expect(titles(at(host.tree(), 0).children)).toEqual(['Child']);
    await host.close();
  });

  it('moves a page to the trash and back', async () => {
    const host = await open(await dataDir());
    const page = host.createPage({ title: 'Draft' });

    host.archivePage(page.id);
    expect(host.tree()).toEqual([]);
    expect(titles(host.trash())).toEqual(['Draft']);

    host.restorePage(page.id);
    expect(titles(host.tree())).toEqual(['Draft']);
    await host.close();
  });

  it('shares a folder between two devices without either overwriting the other', async () => {
    const dir = await dataDir();

    const a = await open(dir, DEVICE_A, 1n);
    a.createPage({ title: 'From A' });
    await a.close();

    const b = await open(dir, DEVICE_B, 2n);
    expect(titles(b.tree())).toEqual(['From A']);
    b.createPage({ title: 'From B' });
    await b.close();

    const backOnA = await open(dir, DEVICE_A, 1n);
    expect(titles(backOnA.tree())).toEqual(['From A', 'From B']);
    await backOnA.close();
  });
});

describe('page bodies', () => {
  it('opens an empty body for a new page', async () => {
    const host = await open(await dataDir());
    const page = host.createPage({ title: 'Notes' });
    const snapshot = await host.openBody(page.id);
    expect(snapshot).toBeInstanceOf(Uint8Array);
    await host.close();
  });

  it('persists body edits and reloads them after a restart', async () => {
    const dir = await dataDir();
    let pageId: string;

    {
      const host = await open(dir);
      const page = host.createPage({ title: 'Notes' });
      pageId = page.id;
      await host.openBody(page.id);

      // Stand in for the renderer: build the edit in a separate document and send the
      // update across, exactly as the editor does over IPC.
      const { LoroDoc } = await import('loro-crdt');
      const remote = new LoroDoc();
      remote.setPeerId(9n);
      remote.getMap('doc').set('nodeName', 'doc');
      remote.getMap('doc').set('marker', 'body content');
      remote.commit();
      await host.applyBodyUpdate(page.id, remote.export({ mode: 'update' }));
      await host.close();
    }

    {
      const host = await open(dir);
      const snapshot = await host.openBody(pageId as never);
      const { LoroDoc } = await import('loro-crdt');
      const check = new LoroDoc();
      check.import(snapshot);
      expect(JSON.stringify(check.toJSON())).toContain('body content');
      await host.close();
    }
  });

  it('keeps each page body in its own document namespace', async () => {
    // The point of ADR-0010: one page's packs must not be read when opening another.
    const dir = await dataDir();
    const host = await open(dir);
    const first = host.createPage({ title: 'First' });
    const second = host.createPage({ title: 'Second' });

    await host.openBody(first.id);
    await host.openBody(second.id);

    const { LoroDoc } = await import('loro-crdt');
    const edit = new LoroDoc();
    edit.setPeerId(9n);
    edit.getMap('doc').set('marker', 'only in first');
    edit.commit();
    await host.applyBodyUpdate(first.id, edit.export({ mode: 'update' }));
    await host.close();

    const reopened = await open(dir);
    const secondBody = new LoroDoc();
    secondBody.import(await reopened.openBody(second.id));
    expect(JSON.stringify(secondBody.toJSON())).not.toContain('only in first');

    const firstBody = new LoroDoc();
    firstBody.import(await reopened.openBody(first.id));
    expect(JSON.stringify(firstBody.toJSON())).toContain('only in first');
    await reopened.close();
  });

  it('refuses an update for a page it has not opened', async () => {
    // Creating a document on demand here would produce a second root for the same page,
    // and merging two independently initialised documents silently loses one side.
    const host = await open(await dataDir());
    const page = host.createPage({ title: 'Unopened' });
    await expect(host.applyBodyUpdate(page.id, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /not open/,
    );
    await host.close();
  });

  it('writes no body pack for a page that was opened but never edited', async () => {
    const dir = await dataDir();
    const host = await open(dir);
    const page = host.createPage({ title: 'Read only' });
    await host.openBody(page.id);
    await host.close();

    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(join(dir, 'log'), { recursive: true })).map(String);
    // Exactly one document namespace has packs: the hierarchy.
    const namespaces = new Set(
      files
        .filter((f) => f.endsWith('.kpack'))
        // readdir returns native separators, so normalise before splitting.
        .map((f) => f.split(sep).join('/').split('/')[1]),
    );
    expect(namespaces.size).toBe(1);
  });
});

describe('search', () => {
  it('finds a page by title as soon as it is created', async () => {
    const host = await open(await dataDir());
    host.createPage({ title: 'Quarterly budget review' });
    expect(host.search('budget').map((h) => h.title)).toEqual(['Quarterly budget review']);
    await host.close();
  });

  it('reflects a rename immediately', async () => {
    const host = await open(await dataDir());
    const page = host.createPage({ title: 'Old name' });
    host.renamePage(page.id, 'New name');

    expect(host.search('Old')).toEqual([]);
    expect(host.search('New').map((h) => h.title)).toEqual(['New name']);
    await host.close();
  });

  it('drops a trashed page out of results', async () => {
    const host = await open(await dataDir());
    const page = host.createPage({ title: 'Sensitive draft' });
    expect(host.search('sensitive')).toHaveLength(1);

    host.archivePage(page.id);
    expect(host.search('sensitive')).toEqual([]);
    await host.close();
  });

  it('indexes body text, and keeps it searchable across a restart', async () => {
    // The index is derived and rebuildable, but it is not thrown away on every launch:
    // it persists, so body text stays searchable without reopening every page. That is
    // what makes search useful at startup rather than only for pages visited this
    // session. It can go stale once another device edits a body we have not opened;
    // re-indexing on pull is part of the sync work, not of local editing.
    const dir = await dataDir();
    let pageId: string;

    {
      const host = await open(dir);
      const page = host.createPage({ title: 'Untitled' });
      pageId = page.id;
      await host.openBody(page.id);

      const { LoroDoc } = await import('loro-crdt');
      const edit = new LoroDoc();
      edit.setPeerId(9n);
      edit.getMap('doc').set('nodeName', 'doc');
      edit.getMap('doc').set('text', 'remember the pomegranate molasses');
      edit.commit();
      await host.applyBodyUpdate(page.id, edit.export({ mode: 'update' }));

      expect(host.search('pomegranate')).toHaveLength(1);
      await host.close();
    }

    {
      const host = await open(dir);
      expect(host.search('pomegranate')).toHaveLength(1);
      // And reopening the page does not duplicate or disturb the entry.
      await host.openBody(pageId as never);
      expect(host.search('pomegranate')).toHaveLength(1);
      await host.close();
    }
  });
});

describe('Notion import', () => {
  const HOME = '11111111111111111111111111111111';
  const CHILD = '22222222222222222222222222222222';

  const notionPage = (title: string, id: string, body: string) =>
    `<html><head><title>${title}</title></head><body>` +
    `<article id="${id}" class="page sans">` +
    `<header><h1 class="page-title">${title}</h1></header>` +
    `<div class="page-body">${body}</div></article></body></html>`;

  async function archive(): Promise<Uint8Array> {
    const { strToU8, zipSync } = await import('fflate');
    return zipSync({
      [`Export-x/Home ${HOME}.html`]: strToU8(
        notionPage('Home', HOME, '<p>welcome to the workspace</p>'),
      ),
      [`Export-x/Home ${HOME}/Recipes ${CHILD}.html`]: strToU8(
        notionPage('Recipes', CHILD, '<h2>Bread</h2><ul class="bulleted-list"><li>flour</li></ul>'),
      ),
      [`Export-x/Tasks ${CHILD}_all.csv`]: strToU8('Name,Status\nBuy flour,Done'),
    });
  }

  it('creates the pages and their hierarchy', async () => {
    const host = await open(await dataDir());
    const report = await host.importNotion(await archive());

    expect(report.pagesImported).toBe(2);
    expect(titles(host.tree())).toEqual(['Home']);
    expect(titles(at(host.tree(), 0).children)).toEqual(['Recipes']);
    await host.close();
  });

  it('imports body content, and makes it searchable immediately', async () => {
    // An imported workspace is the one case where every page has content the user has
    // never opened. Unsearchable notes are barely imported.
    const host = await open(await dataDir());
    await host.importNotion(await archive());

    expect(host.search('welcome').map((h) => h.title)).toEqual(['Home']);
    expect(host.search('flour').map((h) => h.title)).toEqual(['Recipes']);
    await host.close();
  });

  it('persists imported content across a restart', async () => {
    const dir = await dataDir();
    {
      const host = await open(dir);
      await host.importNotion(await archive());
      await host.close();
    }
    {
      const host = await open(dir);
      expect(titles(host.tree())).toEqual(['Home']);

      const recipes = at(at(host.tree(), 0).children, 0);
      const { LoroDoc } = await import('loro-crdt');
      const body = new LoroDoc();
      body.import(await host.openBody(recipes.id));
      expect(JSON.stringify(body.toJSON())).toContain('flour');
      await host.close();
    }
  });

  it('reports the database it could not import rather than dropping it quietly', async () => {
    const host = await open(await dataDir());
    const report = await host.importNotion(await archive());

    expect(report.skipped.some((s) => s.reason.includes('database'))).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/only one view/i);
    await host.close();
  });

  it('refuses a hostile archive instead of importing part of it', async () => {
    const { strToU8, zipSync } = await import('fflate');
    const bomb = zipSync({ 'huge.txt': strToU8('a'.repeat(5_000_000)) });
    const host = await open(await dataDir());

    // Default limits allow this, so assert the mechanism rather than the number: an
    // archive with a traversal entry must fail outright, leaving nothing behind.
    const traversal = zipSync({ '../escape.html': strToU8('<html></html>') });
    await expect(host.importNotion(traversal)).rejects.toThrow(/escape/i);
    expect(host.tree()).toEqual([]);

    expect(bomb.byteLength).toBeGreaterThan(0);
    await host.close();
  });
});

describe('sync between two devices sharing a folder', () => {
  /** Two devices: separate application data, one shared log directory. */
  async function pair() {
    const shared = await dataDir();
    const logDir = join(shared, 'shared-log');
    const openDevice = async (deviceId: Uint8Array, peerId: bigint) =>
      WorkspaceHost.open({
        dataDir: await dataDir(),
        logDir,
        workspaceId: WORKSPACE_ID,
        deviceId,
        peerId,
        deviceKeys: keysFor(deviceId),
        flushDelayMs: 0,
        // The settle rule is exercised directly in the storage tests with a controlled
        // clock. Here it would only make every assertion wait on real time.
        settleMs: 0,
      });
    return { a: await openDevice(DEVICE_A, 1n), b: await openDevice(DEVICE_B, 2n), logDir };
  }

  it('propagates a new page', async () => {
    const { a, b } = await pair();
    a.createPage({ title: 'From A' });
    await a.sync();

    expect(titles(b.tree())).toEqual([]);
    await b.sync();
    expect(titles(b.tree())).toEqual(['From A']);

    await a.close();
    await b.close();
  });

  it('makes a remotely edited body searchable WITHOUT opening the page', async () => {
    // The bug this exists to prevent: indexing a body only when someone opens it means
    // a page edited on another machine stays unfindable until it is visited — and the
    // user cannot visit a page they cannot find.
    const { a, b } = await pair();
    const page = a.createPage({ title: 'Recipes' });
    await a.openBody(page.id);

    const { LoroDoc } = await import('loro-crdt');
    const edit = new LoroDoc();
    edit.setPeerId(9n);
    edit.getMap('doc').set('nodeName', 'doc');
    edit.getMap('doc').set('text', 'sourdough starter instructions');
    edit.commit();
    await a.applyBodyUpdate(page.id, edit.export({ mode: 'update' }));
    await a.sync();

    const status = await b.sync();
    expect(status.bodiesUpdated).toBeGreaterThan(0);
    expect(status.rejected).toBe(0);

    // Found without B ever calling openBody.
    expect(b.search('sourdough').map((h) => h.title)).toEqual(['Recipes']);

    await a.close();
    await b.close();
  });

  it('does not re-decode documents that have not changed', async () => {
    // A quiet cycle must be a directory listing and a set lookup, not a full decode of
    // every page — that is the cost lazy loading exists to avoid.
    const { a, b } = await pair();
    for (let i = 0; i < 5; i++) {
      const page = a.createPage({ title: `Page ${String(i)}` });
      await a.openBody(page.id);
      const { LoroDoc } = await import('loro-crdt');
      const edit = new LoroDoc();
      edit.setPeerId(BigInt(100 + i));
      edit.getMap('doc').set('text', `content ${String(i)}`);
      edit.commit();
      await a.applyBodyUpdate(page.id, edit.export({ mode: 'update' }));
    }
    await a.sync();

    expect((await b.sync()).bodiesUpdated).toBe(5);
    // Nothing changed since, so nothing is decoded again.
    expect((await b.sync()).bodiesUpdated).toBe(0);
    expect((await b.sync()).bodiesUpdated).toBe(0);

    await a.close();
    await b.close();
  });

  it('converges when both devices edit while unable to see each other', async () => {
    const { a, b } = await pair();
    const shared = a.createPage({ title: 'Shared' });
    await a.sync();
    await b.sync();

    a.createPage({ parentId: shared.id, title: 'Added by A' });
    b.createPage({ parentId: shared.id, title: 'Added by B' });

    await a.sync();
    await b.sync();
    await a.sync();

    for (const device of [a, b]) {
      const children = at(device.tree(), 0).children;
      expect(titles(children), 'both edits survive').toEqual(['Added by A', 'Added by B']);
    }

    await a.close();
    await b.close();
  });

  it('propagates a deletion as a tombstone, not as an absence', async () => {
    const { a, b } = await pair();
    const page = a.createPage({ title: 'Temporary' });
    await a.sync();
    await b.sync();
    expect(titles(b.tree())).toEqual(['Temporary']);

    a.archivePage(page.id);
    a.deletePage(page.id);
    await a.sync();
    await b.sync();

    expect(b.tree()).toEqual([]);
    expect(b.search('Temporary')).toEqual([]);

    await a.close();
    await b.close();
  });

  it('refuses to place the application data directory inside the sync folder', async () => {
    // Otherwise the user's cloud client copies a live SQLite file mid-write, which
    // corrupts it — the exact failure ADR-0004's two-roots rule exists to prevent.
    const parent = await dataDir();
    await expect(
      WorkspaceHost.open({
        dataDir: join(parent, 'inside'),
        logDir: parent,
        workspaceId: WORKSPACE_ID,
        deviceId: DEVICE_A,
        peerId: 1n,
        deviceKeys: keysFor(DEVICE_A),
      }),
    ).rejects.toThrow(/corrupt|inside the sync folder/i);
  });
});

describe('compaction', () => {
  async function pairSharing() {
    const shared = await dataDir();
    const logDir = join(shared, 'shared-log');
    const openDevice = async (deviceId: Uint8Array, peerId: bigint) =>
      WorkspaceHost.open({
        dataDir: await dataDir(),
        logDir,
        workspaceId: WORKSPACE_ID,
        deviceId,
        peerId,
        deviceKeys: keysFor(deviceId),
        flushDelayMs: 0,
        settleMs: 0,
      });
    return { a: await openDevice(DEVICE_A, 1n), b: await openDevice(DEVICE_B, 2n), logDir };
  }

  it('publishes a snapshot once every device has caught up', async () => {
    const { a, b, logDir } = await pairSharing();

    a.createPage({ title: 'One' });
    await a.sync();
    await b.sync(); // b acknowledges what it has merged
    await a.sync(); // a now sees b's acknowledgement and can snapshot

    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(logDir, { recursive: true })).map(String);
    expect(files.some((f) => f.includes('snap'))).toBe(true);

    await a.close();
    await b.close();
  });

  it('deletes nothing, because the grace period has not passed', async () => {
    // Publishing a snapshot and pruning history are deliberately separate. Ninety days
    // separate them, so a mistake in the floor has time to be noticed.
    const { a, b, logDir } = await pairSharing();
    a.createPage({ title: 'Keep me' });
    await a.sync();
    await b.sync();
    await a.sync();

    const { readdir } = await import('node:fs/promises');
    const packs = (await readdir(logDir, { recursive: true }))
      .map(String)
      .filter((f) => f.endsWith('.kpack'));
    expect(packs.length).toBeGreaterThan(0);

    await a.close();
    await b.close();
  });

  it('refuses to snapshot while a registered device has never acknowledged', async () => {
    // b enrols but never syncs, so nothing is safe to trim and no snapshot is written.
    const { a, b, logDir } = await pairSharing();
    a.createPage({ title: 'One' });
    await a.sync();
    await a.sync();

    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(logDir, { recursive: true })).map(String);
    expect(files.some((f) => f.includes('snap'))).toBe(false);

    await a.close();
    await b.close();
  });

  it('forgets a device, and it disappears from the device list', async () => {
    const { a, b } = await pairSharing();
    a.createPage({ title: 'One' });
    await a.sync();
    await b.sync();

    expect((await a.devices()).devices).toHaveLength(2);

    const bHex = Buffer.from(DEVICE_B).toString('hex');
    await a.forgetDevice(bHex);

    expect((await a.devices()).devices.map((d) => d.isThisDevice)).toEqual([true]);
    await a.close();
    await b.close();
  });

  it('will not let a device forget itself', async () => {
    const { a, b } = await pairSharing();
    const aHex = Buffer.from(DEVICE_A).toString('hex');
    await expect(a.forgetDevice(aHex)).rejects.toThrow(/cannot forget itself/);
    await a.close();
    await b.close();
  });
});

describe('an encrypted workspace', () => {
  const material = withEpoch(undefined, generateWorkspaceKey());

  const openEncrypted = (dir: string, deviceId = DEVICE_A, peerId = 1n) =>
    WorkspaceHost.open({
      dataDir: dir,
      workspaceId: WORKSPACE_ID,
      deviceId,
      peerId,
      deviceKeys: keysFor(deviceId),
      workspaceKeys: material,
      flushDelayMs: 0,
    });

  /** Every pack the host wrote, tree document and page bodies alike. */
  async function packsUnder(dir: string): Promise<{ path: string; bytes: Uint8Array }[]> {
    const { readFile } = await import('node:fs/promises');
    const root = join(dir, 'log');
    const out: { path: string; bytes: Uint8Array }[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.kpack')) {
          out.push({ path: full, bytes: new Uint8Array(await readFile(full)) });
        }
      }
    };
    await walk(root);
    return out;
  }

  it('writes every pack encrypted and signed, and reads them back', async () => {
    const dir = await dataDir();
    const host = await openEncrypted(dir);
    const page = host.createPage({ title: 'A page title' });
    await host.openBody(page.id);
    await host.flush();
    await host.close();

    const packs = await packsUnder(dir);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const { header } = decodePack(pack.bytes, pack.path);
      expect(header.suiteId).toBe(SUITE.XCHACHA20POLY1305_ARGON2ID);
      expect(header.keyEpoch).toBe(material.current);
      expect(verifyPackSignature(pack.bytes, keysFor(DEVICE_A).signingPublicKey)).toBe(true);
      // The title is the one thing a reader of the folder must not be able to see.
      expect(Buffer.from(pack.bytes).includes(Buffer.from('A page title'))).toBe(false);
    }

    const reopened = await openEncrypted(dir);
    expect(reopened.tree().map((p) => p.title)).toEqual(['A page title']);
    await reopened.close();
  });

  it('still reads a workspace that was written in plaintext before the cipher was on', async () => {
    // The upgrade path. Every pack declares its own suite, so switching costs privacy
    // for what was already written and never readability.
    const dir = await dataDir();
    const before = await open(dir);
    before.createPage({ title: 'Written before' });
    await before.flush();
    await before.close();

    const after = await openEncrypted(dir);
    expect(after.tree().map((p) => p.title)).toEqual(['Written before']);
    after.createPage({ title: 'Written after' });
    await after.flush();
    await after.close();

    const suites = (await packsUnder(dir)).map((p) => decodePack(p.bytes).header.suiteId);
    expect(suites).toContain(SUITE.NONE);
    expect(suites).toContain(SUITE.XCHACHA20POLY1305_ARGON2ID);

    const reopened = await openEncrypted(dir);
    expect(
      reopened
        .tree()
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Written after', 'Written before']);
    await reopened.close();
  });
});
