/**
 * End-to-end: one running copy per profile, and profiles still independent.
 *
 * FORMAT.md section 9 allows exactly one writer for a device's folder, and on a desktop
 * the device is the profile. The unit tests prove the lock logic calls what it should;
 * only a real second Electron process proves the lock is actually taken, on the right
 * directory, before anything opens the workspace, and that the process which loses it
 * really goes away instead of lingering with a hidden window.
 *
 * The second copy is started with a plain spawn rather than through Playwright, because
 * Playwright's launcher waits to attach to a window, and a correct second copy never
 * makes one. Its exit is what the first test asserts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import { expect, test } from '@playwright/test';

import { desktopRoot, flush, launchFreshApp } from './helpers.js';

// In plain Node the electron package evaluates to the path of its binary, which is what
// Playwright itself launches.
const electronBinary = createRequire(import.meta.url)('electron') as string;

/** How long the losing copy may take to notice and leave; the spec asks for about 10 s. */
const EXIT_WITHIN_MS = 10_000;

/**
 * Start Electron on a profile the way Playwright's launcher starts the first copy.
 *
 * Two of the launcher's adjustments decide whether the process gets as far as the lock
 * at all. On Linux it adds --no-sandbox, since a CI runner may not allow Chromium's
 * sandbox, and without it Electron aborts during start-up. And it drops NODE_OPTIONS,
 * which in a test worker can carry the test runner's own module loader into Electron's
 * main process. Either would make the second copy exit for a reason that has nothing to
 * do with the lock, and an exit is exactly what the test is waiting for, so the copy is
 * started with both.
 */
function spawnElectron(profile: string): { child: ChildProcess; stderr: () => string } {
  const args = [desktopRoot, `--user-data-dir=${profile}`];
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const child = spawn(electronBinary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

/** How a process ended: an exit code, or the signal that ended it. */
interface Ending {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Resolve with how the process ended, or reject if it is still running at `ms`. */
function exitWithin(child: ChildProcess, ms: number): Promise<Ending> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the second copy was still running after ${String(ms)} ms`));
    }, ms);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Every file under a directory with its size, to compare before and after.
 *
 * Names and sizes rather than modification times: a new pack, or a head.json or
 * compaction.json rewritten from a different view of the log, changes one of those,
 * while a timestamp would also flag harmless rewrites of identical bytes.
 */
async function snapshotFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${relative(root, full)} ${String((await stat(full)).size)}`);
    }
  };
  await walk(root);
  return out.sort();
}

test('a second launch on the same profile leaves at once and brings the first window back', async () => {
  const first = await launchFreshApp();
  let second: ChildProcess | undefined;

  try {
    // The first copy is left idle from here on, so any change to its log can only have
    // come from the second. Nothing is edited on purpose: a new page's body is written
    // on the renderer's own schedule, which a flush does not reach, and would show up
    // below as a change the second copy never made.
    await flush(first.window);
    const logBefore = await snapshotFiles(join(first.profile, 'log'));
    expect(logBefore.length).toBeGreaterThan(0);

    // Record the primary's side of the handshake, and minimise its window so there is
    // something for the second launch to undo. Under a display with no window manager
    // (CI's Xvfb) minimising does nothing, and the restore check below passes trivially;
    // on Windows and macOS it is a real check.
    await first.app.evaluate(({ app, BrowserWindow }) => {
      const flag = globalThis as { secondInstanceSeen?: boolean };
      flag.secondInstanceSeen = false;
      app.on('second-instance', () => {
        flag.secondInstanceSeen = true;
      });
      BrowserWindow.getAllWindows()[0]?.minimize();
    });

    const launched = spawnElectron(first.profile);
    second = launched.child;
    // Exit code 0 is the deliberate exit. A crash, or a launch failure for some unrelated
    // reason, would also make it exit, which is why the handshake is checked as well.
    const ending = await exitWithin(second, EXIT_WITHIN_MS);
    expect(ending, `the second copy's stderr:\n${launched.stderr()}`).toEqual({
      code: 0,
      signal: null,
    });
    await expect
      .poll(() =>
        first.app.evaluate(
          () => (globalThis as { secondInstanceSeen?: boolean }).secondInstanceSeen,
        ),
      )
      .toBe(true);

    // The first copy is still the only one, back on screen, and still answering.
    expect(first.app.windows()).toHaveLength(1);
    await expect
      .poll(() =>
        first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
      )
      .toBe(false);
    await expect(first.window.getByRole('button', { name: 'New page' })).toBeVisible();
    expect(await first.window.evaluate(() => document.readyState)).toBe('complete');

    // And the second copy wrote nothing into the workspace it was turned away from.
    await flush(first.window);
    expect(await snapshotFiles(join(first.profile, 'log'))).toEqual(logBefore);
  } finally {
    // Only reached with a live second copy when an assertion above failed; never leave
    // it running on a profile that is about to be deleted.
    if (second?.exitCode === null) second.kill();
    await first.close();
  }
});

test('two launches on different profiles both run, side by side', async () => {
  // Each launch walks the full recovery ceremony, so this test does it twice.
  test.setTimeout(120_000);

  const first = await launchFreshApp();
  try {
    const second = await launchFreshApp();
    try {
      expect(second.profile).not.toBe(first.profile);
      for (const running of [first, second]) {
        await expect(running.window.getByRole('button', { name: 'New page' })).toBeVisible();
        expect(await running.window.evaluate(() => document.readyState)).toBe('complete');
      }
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
