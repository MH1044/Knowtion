/**
 * End-to-end: a workspace survives a restart, on a real filesystem.
 *
 * This is the v0.1 promise reduced to a test. The in-memory document is discarded
 * entirely between phases, so the only thing carrying state is the log on disk.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Workspace, deterministicRuntime } from '@knowtion/engine';

import { NodeStorage } from '../node-storage.js';
import { PackStore, packPath } from '../pack-store.js';

const WORKSPACE_ID = new Uint8Array(16).fill(0x11);
const DEVICE_A = new Uint8Array(16).fill(0xaa);
const DEVICE_B = new Uint8Array(16).fill(0xbb);
const hexA = 'aa'.repeat(16);
const TREE = '0'.repeat(32);

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<NodeStorage> {
  const root = await mkdtemp(join(tmpdir(), 'knowtion-persist-'));
  roots.push(root);
  return new NodeStorage(root);
}

function session(storage: NodeStorage, deviceId: Uint8Array, seed: number, peerId: bigint) {
  const workspace = Workspace.create({ runtime: deterministicRuntime(seed), peerId });
  const store = new PackStore({ storage, workspaceId: WORKSPACE_ID, deviceId });
  return { workspace, store };
}

const titles = (pages: { title: string }[]) => pages.map((p) => p.title).sort();

/** Unwraps a lookup the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

describe('a workspace survives a restart', () => {
  it('reloads the full hierarchy from packs alone', async () => {
    const storage = await folder();

    // First run: create some pages, save, then throw everything away.
    {
      const { workspace, store } = session(storage, DEVICE_A, 1, 1n);
      const home = workspace.createPage({ title: 'Home' });
      workspace.createPage({ parentId: home.id, title: 'Groceries' });
      const projects = workspace.createPage({ title: 'Projects' });
      workspace.createPage({ parentId: projects.id, title: 'Knowtion' });
      await store.push(workspace.doc);
    }

    // Second run: nothing in memory, only the folder on disk.
    {
      const { workspace, store } = session(storage, DEVICE_A, 2, 1n);
      expect(workspace.allPages()).toEqual([]); // genuinely empty before the pull
      const result = await store.pull(workspace.doc);

      expect(result.rejected).toEqual([]);
      expect(workspace.allPages()).toHaveLength(4);
      expect(titles(workspace.tree())).toEqual(['Home', 'Projects']);
      const home = must(
        workspace.tree().find((p) => p.title === 'Home'),
        'the Home page in the tree',
      );
      expect(titles(home.children)).toEqual(['Groceries']);
    }
  });

  it('accumulates edits across many sessions, each appending one pack', async () => {
    // The bug this pins: a pack already merged is skipped without being re-read, so a
    // chain tip tracked only within one pull is empty for that device and the NEXT pack
    // looks like it follows nothing. It fails on the second pack a device writes, which
    // is to say immediately in real use.
    const storage = await folder();

    for (let run = 1; run <= 5; run++) {
      const { workspace, store } = session(storage, DEVICE_A, run, 1n);
      const result = await store.pull(workspace.doc);
      expect(result.rejected, `run ${String(run)}`).toEqual([]);
      expect(workspace.allPages(), `run ${String(run)}`).toHaveLength(run - 1);
      workspace.createPage({ title: `Page ${String(run)}` });
      await store.push(workspace.doc);
    }

    const { workspace, store } = session(storage, DEVICE_A, 99, 1n);
    await store.pull(workspace.doc);
    expect(titles(workspace.tree())).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);

    // One pack per session, none rewritten.
    const packs = (await storage.list(`d/${hexA}/${TREE}`)).filter((o) =>
      o.path.endsWith('.kpack'),
    );
    expect(packs).toHaveLength(5);
    expect(packs.map((p) => p.path)).toContain(packPath(hexA, TREE, 5));
  });

  it('two devices sharing one folder converge, including page moves', async () => {
    const storage = await folder();

    const a = session(storage, DEVICE_A, 1, 1n);
    const home = a.workspace.createPage({ title: 'Home' });
    const inbox = a.workspace.createPage({ title: 'Inbox' });
    const note = a.workspace.createPage({ parentId: inbox.id, title: 'Note' });
    await a.store.push(a.workspace.doc);

    const b = session(storage, DEVICE_B, 2, 2n);
    await b.store.pull(b.workspace.doc);
    expect(b.workspace.allPages()).toHaveLength(3);

    // Each device does something the other cannot see.
    a.workspace.renamePage(home.id, 'Home renamed on A');
    b.workspace.movePage(note.id, home.id);
    await a.store.push(a.workspace.doc);
    await b.store.push(b.workspace.doc);
    await a.store.pull(a.workspace.doc);
    await b.store.pull(b.workspace.doc);

    for (const side of [a, b]) {
      expect(side.workspace.getPage(home.id).title).toBe('Home renamed on A');
      expect(side.workspace.getPage(note.id).parentId).toBe(home.id);
      expect(titles(side.workspace.listChildren(home.id))).toEqual(['Note']);
    }
  });

  it('a page archived on one device is in the trash on the other', async () => {
    const storage = await folder();
    const a = session(storage, DEVICE_A, 1, 1n);
    const draft = a.workspace.createPage({ title: 'Draft' });
    await a.store.push(a.workspace.doc);

    const b = session(storage, DEVICE_B, 2, 2n);
    await b.store.pull(b.workspace.doc);

    a.workspace.archivePage(draft.id);
    await a.store.push(a.workspace.doc);
    await b.store.pull(b.workspace.doc);

    expect(b.workspace.tree()).toEqual([]);
    expect(titles(b.workspace.trash())).toEqual(['Draft']);
  });
});
