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

import {
  checkRecoveryPhrase,
  equalBytes,
  rotateWorkspaceKey,
  unwrapKeyFromRecoveryPhrase,
  generateRecoveryPhrase,
  generateWorkspaceKey,
  RECOVERY_PHRASE_WORDS,
} from '@knowtion/format';

import { adoptWorkspace, loadOrCreateIdentity, saveIdentity, type Identity } from './identity.js';
import { chooseProtector } from './secret-protector.js';
import { readSettings, writeSettings } from './settings.js';
import { checkSyncFolder, copyLog } from './sync-folder.js';
import { DeviceRegistry, NodeStorage } from '@knowtion/sync';

import { WorkspaceHost } from './workspace-host.js';
import {
  collectGrantedKeys,
  currentKey,
  publishKeyWraps,
  readWorkspaceKeys,
  withEpoch,
  writeWorkspaceKeys,
  type WorkspaceKeyMaterial,
} from './workspace-keys.js';

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
let protectorDescription = '';
/** Absent until the recovery phrase has been confirmed. Until then nothing is written. */
let workspaceKeys: WorkspaceKeyMaterial | undefined;
/**
 * The phrase shown but not yet confirmed.
 *
 * Held here rather than in the renderer so the confirmation is genuinely unskippable
 * (ADR-0007): the main process is what decides whether setup succeeded, and it will not
 * accept an answer it did not itself pose.
 */
let pendingPhrase: { words: string[]; challenge: number[] } | undefined;
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
    await collectNewEpochs();
    await host.sync();
    lastSyncError = undefined;
  } catch (error) {
    // A sync failure must never take the app down: the local workspace is complete on
    // its own, and an unreachable folder is a normal state, not a crash.
    lastSyncError = error instanceof Error ? error.message : String(error);
    console.error('[knowtion] sync failed:', error);
  }
}

/**
 * Pick up any key epoch this device has been granted since the last cycle.
 *
 * This is how a rotation reaches the other devices: the rotating device publishes a
 * wrap per remaining device, and each of them collects it here. A device that misses a
 * cycle simply collects it on the next one, because a wrap is an object that stays put
 * rather than an event that can be missed.
 */
async function collectNewEpochs(): Promise<void> {
  if (workspaceKeys === undefined || identity === undefined || currentLogDir === '') return;

  const { material, problems } = await collectGrantedKeys(
    new NodeStorage(currentLogDir),
    identity.workspaceId,
    identity.keys,
    Buffer.from(identity.deviceId).toString('hex'),
    workspaceKeys,
  );
  for (const problem of problems) {
    console.error(`[knowtion] unreadable key wrap: ${problem}`);
  }
  if (material === undefined || material === workspaceKeys) return;

  workspaceKeys = material;
  await writeWorkspaceKeys(app.getPath('userData'), material, chooseProtector().protector);
  // The host built its keyring at open time, so it has to be rebuilt to seal under the
  // new epoch and to read packs written under it.
  await host?.close();
  await openWorkspace();
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
      // Read from the host rather than from the last sync result, because a device with
      // no sync folder never runs a cycle — and "nothing is being saved" is exactly as
      // true, and exactly as worth saying, on a local-only workspace.
      writeFailure: host?.writeFailure ?? null,
    },
  }));

  ipcMain.handle('sync:now', async () => {
    if (currentLogDir === '') return { ok: true, value: null };
    await runSync();
    return lastSyncError === undefined
      ? { ok: true, value: null }
      : { ok: false, error: lastSyncError };
  });

  /**
   * Whether this installation still needs its recovery phrase.
   *
   * The renderer blocks on this before showing anything else. ADR-0007 makes the
   * confirmation mandatory and unskippable, and the honest way to enforce that is to
   * not open the workspace at all until it is done — so there is never a window in
   * which a note is written in the clear and has to be un-written afterwards.
   */
  ipcMain.handle('keys:status', () => ({
    ok: true,
    value: {
      needsSetup: workspaceKeys === undefined,
      secretsOsBacked,
      protectorDescription,
    },
  }));

  /**
   * Mint a phrase and pose the challenge that will confirm it.
   *
   * Calling this again returns the same pending phrase rather than a fresh one. A user
   * who reopens the panel to finish writing it down must not silently be shown a
   * different phrase from the one they half-copied.
   */
  ipcMain.handle('keys:begin', () => {
    if (workspaceKeys !== undefined) {
      return { ok: false, error: 'this device already has its keys' };
    }
    if (pendingPhrase === undefined) {
      const words = generateRecoveryPhrase().split(' ');
      // Three positions, drawn without replacement and sorted so the prompts read in
      // the order the words appear on the page.
      const positions = new Set<number>();
      while (positions.size < 3) {
        positions.add(1 + Math.floor(Math.random() * RECOVERY_PHRASE_WORDS));
      }
      pendingPhrase = { words, challenge: [...positions].sort((a, b) => a - b) };
    }
    return { ok: true, value: { words: pendingPhrase.words, challenge: pendingPhrase.challenge } };
  });

  /**
   * Check the challenge, then create the workspace key and open the workspace.
   *
   * The answers are checked here rather than in the renderer. The renderer knows the
   * phrase — it displayed it — so this is not about trust; it is about the check being
   * impossible to skip by accident in UI code changed a year from now.
   */
  ipcMain.handle('keys:confirm', async (_event, input: { answers: string[] }) => {
    const pending = pendingPhrase;
    if (pending === undefined) return { ok: false, error: 'no recovery phrase is pending' };

    const expected = pending.challenge.map((position) => pending.words[position - 1]);
    const given = input.answers.map((word) => word.trim().toLowerCase());
    if (given.length !== expected.length || expected.some((word, i) => word !== given[i])) {
      return {
        ok: false,
        error: 'those words do not match the phrase. Check your copy and try again.',
      };
    }

    try {
      await establishKeys(pending.words.join(' '));
      pendingPhrase = undefined;
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('sync:devices', async () => {
    try {
      const listed = await mustHost().devices();
      return {
        ok: true,
        value: {
          thisFingerprint: mustHost().fingerprint,
          secretsOsBacked,
          encrypted: workspaceKeys !== undefined,
          devices: listed.devices.map((d) => ({
            deviceHex: Buffer.from(d.deviceId).toString('hex'),
            label: d.label,
            fingerprint: d.fingerprint,
            enrolledAt: d.enrolledAt,
            isThisDevice: d.isThisDevice,
            hasCurrentKey: d.hasCurrentKey,
          })),
          rejected: listed.rejected,
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Grant another device the key, after a person has compared its fingerprint.
   *
   * Deliberately a separate act from the device appearing in the registry. Enrolment
   * only means somebody wrote a file into the folder, and treating that as permission
   * would hand the workspace key to anyone who can reach it — which is the first
   * adversary SECURITY.md names.
   */
  ipcMain.handle('keys:grant', async (_event, input: { deviceHex: string }) => {
    try {
      return { ok: true, value: { granted: await mustHost().grantCurrentKey(input.deviceHex) } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Revoke a device: rotate the key away from it, then remove its history.
   *
   * Rotation first, deliberately. It is the part that actually protects anything, and
   * if the eviction fails afterwards it can simply be retried — whereas evicting first
   * and then failing to rotate leaves the device gone from the list while still able to
   * read everything written from then on, which is worse than doing nothing because it
   * looks finished.
   *
   * Revocation stops FUTURE reads only. A device that already held the key has already
   * read what it read, and no amount of rotation reaches back into that.
   */
  ipcMain.handle('keys:revoke', async (_event, input: { deviceHex: string; phrase: string }) => {
    try {
      await rotateAwayFrom(input.deviceHex, input.phrase);
      return { ok: true, value: await mustHost().forgetDevice(input.deviceHex) };
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

      // The wraps travel with the log, but a folder the user JOINED will not have one
      // for this device until another device grants it. Publishing ours is a no-op
      // where it already exists.
      await publishOwnWraps();
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

/**
 * Create this workspace's key, then open the workspace for the first time.
 *
 * Order matters. The key is persisted locally BEFORE anything is written to the log:
 * a pack sealed under a key this device could not reload after a crash would be
 * unreadable by the only device that has it, which is the worst possible outcome and
 * costs one await to avoid.
 */
async function establishKeys(phrase: string): Promise<void> {
  const dataDir = app.getPath('userData');
  const protector = chooseProtector().protector;

  checkRecoveryPhrase(phrase);
  const material = withEpoch(undefined, generateWorkspaceKey());
  await writeWorkspaceKeys(dataDir, material, protector);
  workspaceKeys = material;

  await openWorkspace();

  // The wraps go in after the workspace exists, because publishing them needs the log
  // directory, and a failure here is recoverable on the next sync while a failure
  // before the key was stored would not be.
  await publishOwnWraps(phrase);
}

/** Write the recovery wrap and this device's own wrap for the current epoch. */
async function publishOwnWraps(phrase?: string): Promise<void> {
  if (workspaceKeys === undefined || identity === undefined) return;
  const logDir = currentLogDir === '' ? join(app.getPath('userData'), 'log') : currentLogDir;
  try {
    await publishKeyWraps(
      new NodeStorage(logDir),
      identity.workspaceId,
      currentKey(workspaceKeys),
      [
        {
          deviceHex: Buffer.from(identity.deviceId).toString('hex'),
          wrappingPublicKey: identity.keys.wrappingPublicKey,
        },
      ],
      phrase,
    );
  } catch (error) {
    // Not fatal: the keys are already stored locally, so the workspace works. The wraps
    // are what lets ANOTHER device in, and the next sync will try again.
    console.error(`[knowtion] could not publish key wraps: ${String(error)}`);
  }
}

/**
 * Mint the next key epoch and grant it to everyone except the named device.
 *
 * The phrase is checked by using it: it must open the CURRENT epoch's recovery wrap.
 * Checking only that it is a well-formed BIP-39 phrase would accept any valid phrase at
 * all, and would then write the new epoch's recovery wrap under words that cannot open
 * anything — quietly destroying the recovery path at the exact moment the user believed
 * they were tightening security.
 */
async function rotateAwayFrom(deviceHex: string, phrase: string): Promise<void> {
  const material = must(workspaceKeys, 'workspace keys');
  const id = must(identity, 'identity');
  const logDir = currentLogDir === '' ? join(app.getPath('userData'), 'log') : currentLogDir;
  const storage = new NodeStorage(logDir);
  const current = currentKey(material);

  const existing = await storage.get(`keys/${String(current.epoch)}/recovery.wrap`);
  if (existing === undefined) {
    throw new Error(
      'this workspace has no recovery wrap to check your phrase against, so the key ' +
        'cannot be rotated safely. Reconnect the sync folder and try again.',
    );
  }
  const opened = unwrapKeyFromRecoveryPhrase(existing, phrase, id.workspaceId);
  if (!equalBytes(opened.key, current.key)) {
    throw new Error('that phrase does not match this workspace');
  }

  // Everyone who can read today, minus the device being removed. A device that was
  // never approved is not granted one now: revocation is not the moment to widen access.
  const listed = await mustHost().devices();
  const recipients = listed.devices
    .filter((d) => d.hasCurrentKey && Buffer.from(d.deviceId).toString('hex') !== deviceHex)
    .map((d) => ({
      deviceHex: Buffer.from(d.deviceId).toString('hex'),
      wrappingPublicKey: d.wrappingPublicKey,
    }));

  const next = rotateWorkspaceKey(current);
  await publishKeyWraps(storage, id.workspaceId, next, recipients, phrase);

  const rotated = withEpoch(material, next);
  await writeWorkspaceKeys(app.getPath('userData'), rotated, chooseProtector().protector);
  workspaceKeys = rotated;

  // The host built its keyring when it opened, so it has to be rebuilt to seal under
  // the new epoch. Old epochs stay in the keyring: their packs are still readable.
  await host?.close();
  await openWorkspace();
}

/** Open the workspace host with whatever keys this device holds. */
async function openWorkspace(): Promise<void> {
  const dataDir = app.getPath('userData');
  host = await WorkspaceHost.open({
    dataDir,
    ...(currentLogDir === '' ? {} : { logDir: currentLogDir }),
    workspaceId: must(identity, 'identity').workspaceId,
    deviceId: must(identity, 'identity').deviceId,
    peerId: must(identity, 'identity').peerId,
    deviceKeys: must(identity, 'identity').keys,
    deviceLabel: must(identity, 'identity').label,
    ...(workspaceKeys === undefined ? {} : { workspaceKeys }),
  });
  scheduleSync();
  startWatching();
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
  protectorDescription = choice.protector.description;
  identity = await loadOrCreateIdentity(dataDir, choice.protector, hostname());

  const settings = await readSettings(dataDir);
  currentLogDir = settings.syncFolder ?? '';

  workspaceKeys = await readWorkspaceKeys(dataDir, choice.protector);
  if (workspaceKeys === undefined) {
    // A device that has been granted an epoch but never stored it — a reinstall over
    // an existing folder — can pick it up without the phrase.
    const collected = await collectGrantedKeys(
      new NodeStorage(currentLogDir === '' ? join(dataDir, 'log') : currentLogDir),
      identity.workspaceId,
      identity.keys,
      Buffer.from(identity.deviceId).toString('hex'),
      undefined,
    ).catch(() => ({ material: undefined, problems: [] as string[] }));
    for (const problem of collected.problems) {
      console.error(`[knowtion] unreadable key wrap: ${problem}`);
    }
    if (collected.material !== undefined) {
      workspaceKeys = collected.material;
      await writeWorkspaceKeys(dataDir, workspaceKeys, choice.protector);
    }
  }

  registerHandlers();

  // The workspace is opened only once this device holds keys. Anything else would mean
  // writing in the clear while the setup window is still open, and an append-only log
  // cannot take that back — ADR-0007's one-way door, in miniature.
  if (workspaceKeys !== undefined) await openWorkspace();

  await createWindow();

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
