import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readSettings, writeSettings } from '../settings.js';
import { checkSyncFolder, copyLog } from '../sync-folder.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowtion-folder-'));
  dirs.push(dir);
  return dir;
}

describe('settings', () => {
  it('round-trips a chosen folder', async () => {
    const dir = await temp();
    await writeSettings(dir, { syncFolder: 'C:/notes' });
    expect(await readSettings(dir)).toEqual({ syncFolder: 'C:/notes' });
  });

  it('treats absent settings as defaults rather than an error', async () => {
    expect(await readSettings(await temp())).toEqual({});
  });

  it('treats damaged settings as defaults rather than refusing to start', async () => {
    // Refusing to open someone's notes because a preferences file is corrupt would be
    // absurd; the defaults are always valid.
    const dir = await temp();
    await writeFile(join(dir, 'settings.json'), '{ not json');
    expect(await readSettings(dir)).toEqual({});
  });

  it('ignores a settings file of the wrong shape', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'settings.json'), '["unexpected"]');
    expect(await readSettings(dir)).toEqual({});
  });
});

describe('checkSyncFolder', () => {
  it('accepts an empty folder', async () => {
    const result = await checkSyncFolder(await temp(), await temp());
    expect(result).toEqual({ ok: true, existingWorkspace: false });
  });

  it('refuses a folder that contains the application data directory', async () => {
    // A cloud client copying the search index while it is being written corrupts it.
    // ADR-0004's two-roots rule, enforced where the user actually makes the mistake.
    const parent = await temp();
    const dataDir = join(parent, 'app-data');
    await mkdir(dataDir, { recursive: true });

    const result = await checkSyncFolder(dataDir, parent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/index|corrupt/i);
  });

  it('reports a folder that already holds a workspace instead of merging into it', async () => {
    // Joining another device's workspace means adopting its identity and keys. Silently
    // merging two separate workspaces would be far worse than refusing.
    const folder = await temp();
    await mkdir(join(folder, 'd', 'aa'), { recursive: true });

    const result = await checkSyncFolder(await temp(), folder);
    expect(result).toEqual({ ok: true, existingWorkspace: true });
  });

  it('does not mind a folder holding the user own unrelated files', async () => {
    const folder = await temp();
    await writeFile(join(folder, 'holiday.jpg'), 'not ours');
    expect(await checkSyncFolder(await temp(), folder)).toEqual({
      ok: true,
      existingWorkspace: false,
    });
  });

  it('reports an unreadable folder rather than throwing', async () => {
    const result = await checkSyncFolder(await temp(), join(await temp(), 'does-not-exist'));
    expect(result.ok).toBe(false);
  });
});

describe('copyLog', () => {
  it('copies every pack, preserving the directory layout', async () => {
    const from = await temp();
    const to = await temp();
    await mkdir(join(from, 'd', 'aa', 'bb'), { recursive: true });
    await writeFile(join(from, 'd', 'aa', 'bb', '000000000001.kpack'), 'one');
    await writeFile(join(from, 'd', 'aa', 'bb', '000000000002.kpack'), 'two');

    expect(await copyLog(from, to)).toBe(2);
    expect((await readdir(join(to, 'd', 'aa', 'bb'))).sort()).toEqual([
      '000000000001.kpack',
      '000000000002.kpack',
    ]);
  });

  it('leaves a pack that is already there untouched', async () => {
    // A pack with the same name is by definition the same pack: the name encodes device
    // and sequence, and the contents are immutable. Overwriting could only do harm.
    const from = await temp();
    const to = await temp();
    await mkdir(join(from, 'd', 'aa', 'bb'), { recursive: true });
    await mkdir(join(to, 'd', 'aa', 'bb'), { recursive: true });
    await writeFile(join(from, 'd', 'aa', 'bb', '000000000001.kpack'), 'source');
    await writeFile(join(to, 'd', 'aa', 'bb', '000000000001.kpack'), 'existing');

    expect(await copyLog(from, to)).toBe(0);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(to, 'd', 'aa', 'bb', '000000000001.kpack'), 'utf8')).toBe(
      'existing',
    );
  });

  it('skips a publish still in flight', async () => {
    const from = await temp();
    const to = await temp();
    await mkdir(join(from, 'd', 'aa', 'bb'), { recursive: true });
    await writeFile(join(from, 'd', 'aa', 'bb', '000000000001.kpack.tmp'), 'partial');
    await writeFile(join(from, 'd', 'aa', 'bb', '000000000001.kpack'), 'complete');

    expect(await copyLog(from, to)).toBe(1);
    expect(await readdir(join(to, 'd', 'aa', 'bb'))).toEqual(['000000000001.kpack']);
  });

  it('copying an empty or missing directory is not an error', async () => {
    expect(await copyLog(join(await temp(), 'nothing'), await temp())).toBe(0);
  });
});
