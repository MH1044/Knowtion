/**
 * Shared steps for the end-to-end specs.
 *
 * Every spec starts the real, built Electron app on a throwaway profile and walks the
 * recovery-phrase ceremony, because ADR-0007 makes that step unskippable and the app has
 * nothing else to show until it is done. Extracted so a second spec does not copy the
 * ceremony and drift from the first.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// The app's own package.json ("main": "dist/main/main.js") tells Electron what to
// load, exactly as it does for a real `electron .` launch.
export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
  /** The throwaway user-data directory; the log lives under `profile/log`. */
  profile: string;
  /** Close the app and remove the profile. Safe to call once, in `finally`. */
  close: () => Promise<void>;
}

/** Launch on a fresh profile and complete the recovery-phrase ceremony. */
export async function launchFreshApp(): Promise<RunningApp> {
  const profile = await mkdtemp(join(tmpdir(), 'knowtion-e2e-'));
  const app = await electron.launch({ args: [desktopRoot, `--user-data-dir=${profile}`] });
  const close = async (): Promise<void> => {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  };

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await expect(window.getByRole('heading', { name: 'Your recovery phrase' })).toBeVisible();
    const words = await window.locator('.setup .phrase .word').allInnerTexts();
    expect(words).toHaveLength(24);
    await window.getByRole('button', { name: 'I have written them down' }).click();

    // Which words are asked for is chosen by the main process, so the test reads the
    // prompts rather than assuming any particular positions.
    const labels = await window.locator('.setup .challenge label > span').allInnerTexts();
    const inputs = window.locator('.setup .challenge input');
    for (const [index, label] of labels.entries()) {
      const position = Number(/Word (\d+)/.exec(label)?.[1]);
      expect(Number.isInteger(position)).toBe(true);
      await inputs.nth(index).fill(words[position - 1] ?? '');
    }
    await window.getByRole('button', { name: 'Confirm and open my workspace' }).click();

    // Both are rendered unconditionally by App.tsx once the workspace is open.
    await expect(window.getByText('Knowtion', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('button', { name: 'New page' })).toBeVisible();

    return { app, window, profile, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Force the debounced pack write, so the log on disk reflects every edit so far. */
export async function flush(window: Page): Promise<void> {
  await window.evaluate(async () => {
    await (window as unknown as { knowtion: { flush(): Promise<unknown> } }).knowtion.flush();
  });
}

/** Every pack under a directory, at any depth. */
export async function findPacks(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.kpack')) out.push(full);
    }
  };
  await walk(root);
  return out;
}
