/**
 * Export, end to end, onto a real disk.
 *
 * README.md has promised this since v0.1, so the thing worth checking is not that the
 * functions compose but that files appear and contain the notes. Every case here starts
 * from a real host, writes a real folder, and reads it back.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { generateDeviceKeys } from '@knowtion/format';

import { loroDocFromJson } from '@knowtion/editor/headless';

import { exportWorkspace } from '../export.js';
import { WorkspaceHost } from '../workspace-host.js';

const WORKSPACE_ID = new Uint8Array(16).fill(0x11);
const DEVICE = new Uint8Array(16).fill(0xaa);

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowtion-export-'));
  dirs.push(dir);
  return dir;
}

/** One keypair for the whole file: nothing here reopens a host, so it never changes. */
const deviceKeys = generateDeviceKeys();

async function openHost(): Promise<WorkspaceHost> {
  return WorkspaceHost.open({
    dataDir: await tempDir(),
    workspaceId: WORKSPACE_ID,
    deviceId: DEVICE,
    peerId: 1n,
    deviceKeys,
    workspaceKeys: 'plaintext',
    flushDelayMs: 0,
  });
}

/** Give a page some text, the way the editor would. */
async function write(host: WorkspaceHost, id: string, text: string): Promise<void> {
  await host.openBody(id as never);
  const doc = loroDocFromJson(
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    2n,
  );
  await host.applyBodyUpdate(id as never, doc.export({ mode: 'snapshot' }));
}

/** Every file under `dir`, as export-root-relative paths with forward slashes. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(join(dir, entry.name), relative)));
    else out.push(relative);
  }
  return out.sort();
}

describe('exporting as Markdown', () => {
  it('writes a file per page, with the tree as folders', async () => {
    const host = await openHost();
    try {
      const parent = host.createPage({ title: 'Projects' });
      const child = host.createPage({ title: 'Knowtion', parentId: parent.id });
      await write(host, child.id, 'the local-first one');

      const out = await tempDir();
      const result = await exportWorkspace(host, out, 'markdown');
      expect(result.pages).toBe(2);
      expect(result.unreadableBodies).toBe(0);
      expect(await filesUnder(out)).toEqual(['Projects.md', 'Projects/Knowtion.md']);

      const text = await readFile(join(out, 'Projects', 'Knowtion.md'), 'utf8');
      expect(text).toContain('# Knowtion');
      expect(text).toContain('the local-first one');
      expect(text).toContain(`uuid: "${child.uuid}"`);
    } finally {
      await host.close();
    }
  }, 60_000);

  it('writes a spreadsheet beside a database, and a page per row', async () => {
    const host = await openHost();
    try {
      const db = host.createPage({ title: 'Tasks' });
      host.convertToDatabase(db.id);
      const status = host.defineProperty(db.id, {
        name: 'Status',
        type: 'select',
        options: [{ name: 'Doing' }],
      });
      const row = host.createRow(db.id, { title: 'Ship it' });
      host.setPropertyValue(row.id, status.id, {
        type: 'select',
        value: status.options[0]?.id ?? ('' as never),
      });

      const out = await tempDir();
      await exportWorkspace(host, out, 'markdown');
      expect(await filesUnder(out)).toEqual(['Tasks.csv', 'Tasks.md', 'Tasks/Ship it.md']);

      const csv = await readFile(join(out, 'Tasks.csv'), 'utf8');
      expect(csv.codePointAt(0)).toBe(0xfeff);
      expect(csv).toContain('Title,Status');
      expect(csv).toContain('Ship it,Doing');

      // The row's own page carries the property by name, not by id.
      const page = await readFile(join(out, 'Tasks', 'Ship it.md'), 'utf8');
      expect(page).toContain('"Status": "Doing"');
    } finally {
      await host.close();
    }
  }, 60_000);

  it('does not let one page with no text stop the rest', async () => {
    const host = await openHost();
    try {
      host.createPage({ title: 'Empty' });
      const written = host.createPage({ title: 'Full' });
      await write(host, written.id, 'here');

      const out = await tempDir();
      const result = await exportWorkspace(host, out, 'markdown');
      expect(result.pages).toBe(2);
      expect(await filesUnder(out)).toEqual(['Empty.md', 'Full.md']);
      // A page nobody has typed in is a heading and its front matter, not a failure.
      expect(await readFile(join(out, 'Empty.md'), 'utf8')).toContain('# Empty');
    } finally {
      await host.close();
    }
  }, 60_000);
});

describe('exporting as JSON', () => {
  it('writes one file holding every page, addressed by uuid', async () => {
    const host = await openHost();
    try {
      const parent = host.createPage({ title: 'Projects' });
      const child = host.createPage({ title: 'Knowtion', parentId: parent.id });
      await write(host, child.id, 'the local-first one');

      const out = await tempDir();
      const result = await exportWorkspace(host, out, 'json');
      expect(result.pages).toBe(2);
      expect(await filesUnder(out)).toEqual(['workspace.json']);

      const parsed = JSON.parse(await readFile(join(out, 'workspace.json'), 'utf8')) as {
        format: string;
        version: number;
        pages: { uuid: string; parent: string | null; title: string; body?: unknown }[];
      };
      expect(parsed.format).toBe('knowtion-export');
      expect(parsed.version).toBe(1);
      expect(parsed.pages.map((p) => p.title)).toEqual(['Projects', 'Knowtion']);

      const root = parsed.pages.find((p) => p.title === 'Projects');
      const inner = parsed.pages.find((p) => p.title === 'Knowtion');
      expect(root?.parent).toBeNull();
      expect(inner?.parent).toBe(parent.uuid);
      expect(inner?.uuid).toBe(child.uuid);
      expect(JSON.stringify(inner?.body)).toContain('the local-first one');
    } finally {
      await host.close();
    }
  }, 60_000);

  it('keeps a database schema and a row’s typed values', async () => {
    const host = await openHost();
    try {
      const db = host.createPage({ title: 'Tasks' });
      host.convertToDatabase(db.id);
      const score = host.defineProperty(db.id, { name: 'Score', type: 'number' });
      const row = host.createRow(db.id, { title: 'Ship it' });
      host.setPropertyValue(row.id, score.id, { type: 'number', value: 7 });

      const out = await tempDir();
      await exportWorkspace(host, out, 'json');
      const parsed = JSON.parse(await readFile(join(out, 'workspace.json'), 'utf8')) as {
        pages: {
          title: string;
          database?: { properties: { name: string }[] };
          properties?: Record<string, { type: string; value: unknown }>;
        }[];
      };
      const database = parsed.pages.find((p) => p.title === 'Tasks');
      expect(database?.database?.properties.map((p) => p.name)).toEqual(['Score']);
      const saved = parsed.pages.find((p) => p.title === 'Ship it');
      expect(saved?.properties?.[score.id]).toEqual({ type: 'number', value: 7 });
    } finally {
      await host.close();
    }
  }, 60_000);
});

describe('page icons', () => {
  it('survive a round trip through the log and reach the export', async () => {
    const host = await openHost();
    try {
      const page = host.createPage({ title: 'Recipes' });
      expect(host.setIcon(page.id, '🍿').icon).toBe('🍿');
      expect(host.page(page.id).icon).toBe('🍿');

      const out = await tempDir();
      await exportWorkspace(host, out, 'markdown');
      expect(await readFile(join(out, 'Recipes.md'), 'utf8')).toContain('icon: "🍿"');

      // Taking it away removes the key rather than storing an empty string.
      expect(host.setIcon(page.id, undefined).icon).toBeUndefined();
      const second = await tempDir();
      await exportWorkspace(host, second, 'markdown');
      expect(await readFile(join(second, 'Recipes.md'), 'utf8')).not.toContain('icon:');
    } finally {
      await host.close();
    }
  }, 60_000);
});
