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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { findPacks, flush, launchFreshApp } from './helpers.js';

test('a fresh install walks the recovery-phrase ceremony and paints the real UI', async () => {
  // The ceremony itself is asserted inside launchFreshApp: the heading, 24 words, the
  // challenge, and the workspace opening with the real UI on screen.
  const { window, profile, close } = await launchFreshApp();

  try {
    // The payoff, checked on the real bytes the real app wrote. Everything else in the
    // suite could pass with the cipher quietly switched off.
    await window.getByRole('button', { name: 'New page' }).click();
    await flush(window);

    const packs = await findPacks(join(profile, 'log'));
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const bytes = await readFile(pack);
      // FORMAT.md section 3: magic at 0, suite_id at 6. 0x01 is XChaCha20-Poly1305.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('KNOW');
      expect(bytes[6]).toBe(0x01);
    }
  } finally {
    await close();
  }
});
