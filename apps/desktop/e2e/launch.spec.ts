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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';

// The app's own package.json ("main": "dist/main/main.js") tells Electron what to
// load, exactly as it does for a real `electron .` launch.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the packaged app paints the real UI, not a blank window', async () => {
  const app = await electron.launch({ args: [desktopRoot] });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Both are rendered unconditionally by App.tsx, so either one missing means the
    // renderer never mounted — the failure mode this test exists to catch.
    await expect(window.getByText('Knowtion', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'New page' })).toBeVisible();
  } finally {
    await app.close();
  }
});
