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

import { WorkspaceHost } from '../workspace-host.js';

const WORKSPACE_ID = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
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
    // Flush on the next tick so tests never wait on a real debounce.
    flushDelayMs: 0,
  });

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
    expect(titles(second.tree()[0]!.children)).toEqual(['Child']);
    await second.close();
  });

  it('writes nothing at all for a workspace nobody touched', async () => {
    // An idle app must not add a file to the user's folder on every launch. In folder
    // mode that is an upload their cloud client performs for no reason, forever.
    const dir = await dataDir();
    const host = await open(dir);
    await host.close();

    const entries = await readdir(dir, { recursive: true });
    expect(entries.filter((e) => String(e).endsWith('.kpack'))).toEqual([]);
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
    for (let i = 0; i < 25; i++) host.createPage({ title: `Page ${i}` });
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
    expect(titles(host.tree()[0]!.children)).toEqual(['Child']);
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
    await host.close();
  });
});
