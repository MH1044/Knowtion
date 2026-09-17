import { defineConfig } from '@playwright/test';

/**
 * Launch smoke test config.
 *
 * The specs drive a real Electron process rather than a browser page, so there is no
 * need for the usual multi-browser project matrix — just a sane timeout and no silent
 * retries hiding a flaky launch. Each spec launches its own app on a fresh profile and
 * walks the recovery ceremony first, which is most of the budget.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
});
