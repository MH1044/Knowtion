/**
 * Electron main process.
 *
 * Owns the filesystem and the workspace. The renderer is sandboxed with context
 * isolation on and Node integration off, so it can only reach this process through the
 * narrow, explicitly-listed channel surface below (SECURITY.md).
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, ipcMain, session } from 'electron';

import { WorkspaceHost } from './workspace-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;

// Set before anything reads a path. Electron derives the user-data directory from the
// application name, and the package name would make that "@knowtion/desktop" — an odd
// nested folder the user would have to find to back up their own notes. Changing it
// once real data exists would strand that data, so it is pinned now.
app.setName('Knowtion');

let host: WorkspaceHost | undefined;

/**
 * Stable identity for this installation.
 *
 * The device identifier decides which log prefix this install owns, and FORMAT.md
 * section 9 gives every path exactly one writer. Two installs sharing an identifier
 * would fork the chain, so it is minted once and never regenerated.
 */
async function loadIdentity(
  dataDir: string,
): Promise<{ workspaceId: Uint8Array; deviceId: Uint8Array; peerId: bigint }> {
  const path = join(dataDir, 'identity.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    return {
      workspaceId: Uint8Array.from(Buffer.from(parsed['workspaceId']!, 'hex')),
      deviceId: Uint8Array.from(Buffer.from(parsed['deviceId']!, 'hex')),
      peerId: BigInt(parsed['peerId']!),
    };
  } catch {
    const workspaceId = Uint8Array.from(randomBytes(16));
    const deviceId = Uint8Array.from(randomBytes(16));
    // Loro peer ids are u64; keep it well inside the range.
    const peerId = BigInt('0x' + randomBytes(6).toString('hex'));
    await writeFile(
      path,
      JSON.stringify(
        {
          workspaceId: Buffer.from(workspaceId).toString('hex'),
          deviceId: Buffer.from(deviceId).toString('hex'),
          peerId: peerId.toString(),
        },
        null,
        2,
      ),
    );
    return { workspaceId, deviceId, peerId };
  }
}

/** Wrap a handler so a thrown engine error reaches the renderer as a plain message. */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, (_event, ...args) => {
    try {
      return { ok: true, value: fn(...(args as never[])) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });
}

function registerHandlers(): void {
  handle('workspace:tree', () => host!.tree());
  handle('workspace:trash', () => host!.trash());
  handle('workspace:create', (input: { parentId?: string; title?: string }) =>
    host!.createPage(input as never),
  );
  handle('workspace:rename', (input: { id: string; title: string }) =>
    host!.renamePage(input.id as never, input.title),
  );
  handle('workspace:move', (input: { id: string; parentId?: string }) =>
    host!.movePage(input.id as never, input.parentId as never),
  );
  handle('workspace:archive', (input: { id: string }) => host!.archivePage(input.id as never));
  handle('workspace:restore', (input: { id: string }) => host!.restorePage(input.id as never));
  handle('workspace:delete', (input: { id: string }) => host!.deletePage(input.id as never));
  ipcMain.handle('workspace:flush', async () => {
    await host!.flush();
    return { ok: true, value: null };
  });

  // Page bodies are asynchronous because opening one reads that page's packs from disk.
  ipcMain.handle('body:open', async (_event, input: { id: string }) => {
    try {
      // Structured clone carries a Uint8Array, so the bytes cross without base64.
      return { ok: true, value: await host!.openBody(input.id as never) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('body:update', async (_event, input: { id: string; update: Uint8Array }) => {
    try {
      await host!.applyBodyUpdate(input.id as never, input.update);
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'Knowtion',
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  await window.loadFile(join(here, '..', 'renderer', 'index.html'));
  if (isDevelopment && process.env['KNOWTION_DEVTOOLS'] === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  // No remote content is ever loaded, so everything is locked to the app's own origin.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'",
        ],
      },
    });
  });

  const dataDir = app.getPath('userData');
  const identity = await loadIdentity(dataDir);
  host = await WorkspaceHost.open({ dataDir, ...identity });
  registerHandlers();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// Debounced writes mean the last few hundred milliseconds only exist in memory.
// Quitting without flushing would lose them, which is exactly the kind of small,
// deniable data loss that destroys trust in a notes app.
app.on('before-quit', (event) => {
  if (!host) return;
  event.preventDefault();
  const pending = host;
  host = undefined;
  void pending.close().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
