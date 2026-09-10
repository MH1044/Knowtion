/**
 * End-to-end launch smoke test.
 *
 * Every other CI check — typecheck, lint, unit tests — exercises source code in
 * isolation. None of them ever start the actual Electron app, so a renderer that
 * throws before React mounts (for example a Content-Security-Policy that silently
 * blocks the app's own WebAssembly module) would pass every one of them. Electron
 * would still exit 0 too, because a fully blank window is not a crash. So this test
 * launches the real, built app through Playwright's Electron support and asserts that
 * real UI text is on screen — not merely that the process started and stopped cleanly.
 *
 * Requires the app to already be built (`npm run build && npm run build -w
 * @knowtion/desktop`, which `npm run test:e2e` does for you). On Linux, Electron needs
 * a display: run under `xvfb-run` (see the `test:e2e` script and CI).
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';

// The app's own package.json ("main": "dist/main/main.js") tells Electron what to
// load, exactly as it does for a real `electron .` launch.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every pack under a directory, at any depth. */
async function findPacks(root: string): Promise<string[]> {
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

test('a fresh install walks the recovery-phrase ceremony and paints the real UI', async () => {
  // A throwaway profile, so the test never touches the developer's own workspace and
  // always exercises the genuine first-run path rather than whatever state was left
  // behind by the last run.
  const profile = await mkdtemp(join(tmpdir(), 'knowtion-e2e-'));
  const app = await electron.launch({ args: [desktopRoot, `--user-data-dir=${profile}`] });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // The workspace is not open yet: ADR-0007 makes this step unskippable, so the app
    // deliberately has nothing else to show until it is done.
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

    // Both are rendered unconditionally by App.tsx once the workspace is open, so
    // either one missing means the renderer never mounted — the failure this test
    // exists to catch — or that key setup silently failed.
    await expect(window.getByText('Knowtion', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('button', { name: 'New page' })).toBeVisible();

    // The payoff, checked on the real bytes the real app wrote. Everything else in the
    // suite could pass with the cipher quietly switched off.
    await window.getByRole('button', { name: 'New page' }).click();
    await window.evaluate(async () => {
      await (window as unknown as { knowtion: { flush(): Promise<unknown> } }).knowtion.flush();
    });

    const packs = await findPacks(join(profile, 'log'));
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const bytes = await readFile(pack);
      // FORMAT.md section 3: magic at 0, suite_id at 6. 0x01 is XChaCha20-Poly1305.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('KNOW');
      expect(bytes[6]).toBe(0x01);
    }
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});
