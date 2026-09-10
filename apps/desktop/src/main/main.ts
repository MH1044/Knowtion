/**
 * Electron main process.
 *
 * Owns the filesystem and the workspace. The renderer is sandboxed with context
 * isolation on and Node integration off, so it can only reach this process through the
 * narrow, explicitly-listed channel surface below (SECURITY.md).
 */

import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, dialog, ipcMain, session } from 'electron';

import { adoptWorkspace, loadOrCreateIdentity, saveIdentity, type Identity } from './identity.js';
import { chooseProtector } from './secret-protector.js';
import { readSettings, writeSettings } from './settings.js';
import { checkSyncFolder, copyLog } from './sync-folder.js';
import { DeviceRegistry, NodeStorage } from '@knowtion/sync';

import { WorkspaceHost } from './workspace-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;

// Set before anything reads a path. Electron derives the user-data directory from the
// application name, and the package name would make that "@knowtion/desktop" — an odd
// nested folder the user would have to find to back up their own notes. Changing it
// once real data exists would strand that data, so it is pinned now.
app.setName('Knowtion');

let host: WorkspaceHost | undefined;
let syncTimer: NodeJS.Timeout | undefined;
let currentLogDir = '';
let lastSyncError: string | undefined;
let identity: Identity | undefined;
let secretsOsBacked = false;
let logWatcher: FSWatcher | undefined;
let watchDebounce: NodeJS.Timeout | undefined;

/** `host`/`identity` are module-level `let`s set once at boot; throws if read too early. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be set`);
  return value;
}

/** IPC handlers below are only registered after `host` is opened in `whenReady`. */
function mustHost(): WorkspaceHost {
  return must(host, 'workspace host');
}

/**
 * How often to look for another device's work.
 *
 * Folder mode has no change feed, so this is a poll. It runs ONLY when a sync folder is
 * configured: with a local-only log there is no other writer, and polling would be
 * background work with nothing to find. Slower when the window is not focused, because
 * a user who is not looking is not waiting.
 */
const SYNC_INTERVAL_FOCUSED_MS = 15_000;
const SYNC_INTERVAL_BACKGROUND_MS = 60_000;

function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  if (currentLogDir === '' || host === undefined) return;

  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  syncTimer = setTimeout(
    () => {
      void runSync().finally(scheduleSync);
    },
    focused ? SYNC_INTERVAL_FOCUSED_MS : SYNC_INTERVAL_BACKGROUND_MS,
  );
}

/**
 * Watch the sync folder, purely to notice another device's work sooner.
 *
 * Node's own watcher is used rather than a native one on purpose. It is unreliable —
 * it misses events on network mounts, and recursive watching is not supported
 * everywhere — and that is acceptable precisely because it is only a hint. The periodic
 * reconcile scan is the correctness mechanism, and deleting this function entirely
 * would leave the system correct, merely slower. A native dependency to make a hint
 * more reliable would be paying for the wrong thing.
 */
function startWatching(): void {
  stopWatching();
  if (currentLogDir === '') return;

  try {
    logWatcher = watch(currentLogDir, { recursive: true }, () => {
      // Coalesced: a cloud client materialising a batch fires many events at once, and
      // one sync afterwards is worth more than one per file.
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        void runSync();
      }, 1_000);
    });
    logWatcher.on('error', () => {
      // Watching is optional. Losing it costs latency, never correctness.
      stopWatching();
    });
  } catch {
    // Recursive watching is unsupported on some platforms and mounts. The scan covers it.
  }
}

function stopWatching(): void {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = undefined;
  logWatcher?.close();
  logWatcher = undefined;
}

async function runSync(): Promise<void> {
  if (!host) return;
  try {
    await host.sync();
    lastSyncError = undefined;
  } catch (error) {
    // A sync failure must never take the app down: the local workspace is complete on
    // its own, and an unreachable folder is a normal state, not a crash.
    lastSyncError = error instanceof Error ? error.message : String(error);
    console.error('[knowtion] sync failed:', error);
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
  handle('workspace:tree', () => mustHost().tree());
  handle('workspace:trash', () => mustHost().trash());
  handle('workspace:create', (input: { parentId?: string; title?: string }) =>
    mustHost().createPage(input as never),
  );
  handle('workspace:rename', (input: { id: string; title: string }) =>
    mustHost().renamePage(input.id as never, input.title),
  );
  handle('workspace:move', (input: { id: string; parentId?: string }) =>
    mustHost().movePage(input.id as never, input.parentId as never),
  );
  handle('workspace:archive', (input: { id: string }) => mustHost().archivePage(input.id as never));
  handle('workspace:restore', (input: { id: string }) => mustHost().restorePage(input.id as never));
  handle('workspace:delete', (input: { id: string }) => {
    mustHost().deletePage(input.id as never);
  });
  handle('workspace:search', (input: { query: string; limit?: number }) =>
    mustHost().search(input.query, input.limit),
  );
  // The file picker runs in the main process: the renderer is sandboxed and has no
  // filesystem access, which is the point of the sandbox.
  ipcMain.handle('import:notion', async () => {
    try {
      const chosen = await dialog.showOpenDialog({
        title: 'Import a Notion export',
        properties: ['openFile'],
        filters: [{ name: 'Notion export', extensions: ['zip'] }],
      });
      if (chosen.canceled || chosen.filePaths[0] === undefined) {
        return { ok: true, value: null };
      }
      const bytes = new Uint8Array(await readFile(chosen.filePaths[0]));
      return { ok: true, value: await mustHost().importNotion(bytes) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('sync:info', () => ({
    ok: true,
    value: {
      folder: currentLogDir === '' ? null : currentLogDir,
      lastError: lastSyncError ?? null,
    },
  }));

  ipcMain.handle('sync:now', async () => {
    if (currentLogDir === '') return { ok: true, value: null };
    await runSync();
    return lastSyncError === undefined
      ? { ok: true, value: null }
      : { ok: false, error: lastSyncError };
  });

  ipcMain.handle('sync:devices', async () => {
    try {
      const listed = await mustHost().devices();
      return {
        ok: true,
        value: {
          thisFingerprint: mustHost().fingerprint,
          secretsOsBacked,
          devices: listed.devices.map((d) => ({
            deviceHex: Buffer.from(d.deviceId).toString('hex'),
            label: d.label,
            fingerprint: d.fingerprint,
            enrolledAt: d.enrolledAt,
            isThisDevice: d.isThisDevice,
          })),
          rejected: listed.rejected,
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('sync:forget', async (_event, input: { deviceHex: string }) => {
    try {
      return { ok: true, value: await mustHost().forgetDevice(input.deviceHex) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Point the log at a folder the user's cloud client already syncs.
   *
   * Two quite different operations behind one button. An empty folder means "move my
   * workspace there", and the existing log is COPIED rather than moved so a mistake is
   * recoverable. A folder that already holds a workspace means "join it", which is
   * pairing: this device adopts that workspace's identifier and mints a fresh log
   * prefix, keeping its own keys.
   */
  ipcMain.handle('sync:choose', async () => {
    try {
      const chosen = await dialog.showOpenDialog({
        title: 'Choose a folder your cloud client syncs',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (chosen.canceled || chosen.filePaths[0] === undefined) {
        return { ok: true, value: null };
      }

      const dataDir = app.getPath('userData');
      const folder = chosen.filePaths[0];
      const check = await checkSyncFolder(dataDir, folder);
      if (!check.ok) return { ok: false, error: check.reason };

      const protector = chooseProtector().protector;

      if (check.existingWorkspace) {
        const remote = await readWorkspaceIdFrom(folder);
        if (remote === undefined) {
          return {
            ok: false,
            error:
              'That folder looks like a Knowtion workspace but no readable device ' +
              'record could be found in it, so there is no way to tell which workspace ' +
              'it is. Check that it has finished syncing.',
          };
        }

        // Joining replaces this device's workspace. Merging two independently created
        // workspaces is not possible — each has its own root document, and combining
        // them keeps one and silently discards the other (ADR-0009). Refusing while
        // there is anything to lose is the only honest option.
        if (mustHost().tree().length > 0 || mustHost().trash().length > 0) {
          return {
            ok: false,
            error:
              'This device already has its own pages, and joining another workspace ' +
              'would replace them. Export them first, or join from a device with an ' +
              'empty workspace. Your existing notes are untouched.',
          };
        }
      }

      // Detach the current host and its timer BEFORE any teardown or reopen I/O below.
      // Both the poll timer and the renderer's "sync now" button call runSync(), whose
      // only guard is `if (!host) return`; leaving `host` pointing at an instance that
      // is mid-close (or already closed) means that guard never trips, and runSync ends
      // up operating on a closed store. Nulling it out here, before `close()` even
      // starts, is what makes the guard correct for the whole transition.
      if (syncTimer) clearTimeout(syncTimer);
      const closingHost = mustHost();
      const previousLogDir = currentLogDir;
      const previousIdentity = must(identity, 'identity');
      host = undefined;

      let nextIdentity = previousIdentity;
      try {
        if (check.existingWorkspace) {
          // re-checked above, folder unchanged
          const remote = must(await readWorkspaceIdFrom(folder), 'workspace id in folder');
          await closingHost.close();
          nextIdentity = await adoptWorkspace(dataDir, previousIdentity, remote, protector);
        } else {
          // Taking our own workspace with us.
          await closingHost.close();
          const sourceLogDir = previousLogDir === '' ? join(dataDir, 'log') : previousLogDir;
          await copyLog(sourceLogDir, folder);
        }

        // Settings and currentLogDir are only committed once the new host actually
        // opens — otherwise a failure below would leave disk state pointing at a
        // folder this process never successfully started using.
        const opened = await WorkspaceHost.open({
          dataDir,
          logDir: folder,
          workspaceId: nextIdentity.workspaceId,
          deviceId: nextIdentity.deviceId,
          peerId: nextIdentity.peerId,
          deviceKeys: nextIdentity.keys,
          deviceLabel: nextIdentity.label,
        });
        await writeSettings(dataDir, { syncFolder: folder });
        currentLogDir = folder;
        identity = nextIdentity;
        host = opened;
      } catch (error) {
        // The switch failed partway through. The user's previous workspace must not be
        // stranded until a restart: put back whatever this attempt changed, and reopen
        // it exactly as it was.
        if (check.existingWorkspace && nextIdentity !== previousIdentity) {
          await saveIdentity(dataDir, previousIdentity, protector);
        }
        identity = previousIdentity;
        currentLogDir = previousLogDir;
        try {
          host = await WorkspaceHost.open({
            dataDir,
            logDir: previousLogDir,
            workspaceId: previousIdentity.workspaceId,
            deviceId: previousIdentity.deviceId,
            peerId: previousIdentity.peerId,
            deviceKeys: previousIdentity.keys,
            deviceLabel: previousIdentity.label,
          });
          scheduleSync();
          startWatching();
        } catch (reopenError) {
          // Both the switch and the rollback failed. Say so plainly rather than
          // returning only the first error and leaving the app silently unusable.
          const first = error instanceof Error ? error.message : String(error);
          const second = reopenError instanceof Error ? reopenError.message : String(reopenError);
          throw new Error(
            `could not switch sync folders (${first}), and reopening the previous ` +
              `workspace also failed (${second}) — restart Knowtion`,
          );
        }
        throw error;
      }

      await runSync();
      scheduleSync();
      startWatching();

      return {
        ok: true,
        value: { folder, joined: check.existingWorkspace, fingerprint: host.fingerprint },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('workspace:flush', async () => {
    await mustHost().flush();
    return { ok: true, value: null };
  });

  // Page bodies are asynchronous because opening one reads that page's packs from disk.
  ipcMain.handle('body:open', async (_event, input: { id: string }) => {
    try {
      // Structured clone carries a Uint8Array, so the bytes cross without base64.
      return { ok: true, value: await mustHost().openBody(input.id as never) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('body:update', async (_event, input: { id: string; update: Uint8Array }) => {
    try {
      await mustHost().applyBodyUpdate(input.id as never, input.update);
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Which workspace a folder belongs to, read from any device record in it.
 *
 * Every record carries the workspace identifier and is self-signed, so one readable
 * record is enough — and an unreadable one is not fatal, because another device's
 * record will usually still be there.
 */
async function readWorkspaceIdFrom(folder: string): Promise<Uint8Array | undefined> {
  const registry = new DeviceRegistry(new NodeStorage(folder));
  const { devices } = await registry.list();
  return devices[0]?.workspaceId;
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

  window.once('ready-to-show', () => {
    window.show();
  });
  await window.loadFile(join(here, '..', 'renderer', 'index.html'));
  if (isDevelopment && process.env.KNOWTION_DEVTOOLS === '1') {
    window.webContents.openDevTools({ mode: 'detach' });
  }
}

void app.whenReady().then(async () => {
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
  const choice = chooseProtector();
  secretsOsBacked = choice.osBacked;
  if (!choice.osBacked) {
    console.warn(
      `[knowtion] no OS secret store available; device keys are ${choice.protector.description}`,
    );
  }
  identity = await loadOrCreateIdentity(dataDir, choice.protector, hostname());

  const settings = await readSettings(dataDir);
  currentLogDir = settings.syncFolder ?? '';

  host = await WorkspaceHost.open({
    dataDir,
    ...(currentLogDir === '' ? {} : { logDir: currentLogDir }),
    workspaceId: identity.workspaceId,
    deviceId: identity.deviceId,
    peerId: identity.peerId,
    deviceKeys: identity.keys,
    deviceLabel: identity.label,
  });
  registerHandlers();
  await createWindow();
  scheduleSync();
  startWatching();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// Debounced writes mean the last few hundred milliseconds only exist in memory.
// Quitting without flushing would lose them, which is exactly the kind of small,
// deniable data loss that destroys trust in a notes app.
app.on('before-quit', (event) => {
  stopWatching();
  if (syncTimer) clearTimeout(syncTimer);
  if (!host) return;
  event.preventDefault();
  const pending = host;
  host = undefined;
  void pending.close().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
