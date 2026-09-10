import { defineConfig } from '@playwright/test';

/**
 * Launch smoke test config.
 *
 * There is exactly one spec, and it drives a real Electron process rather than a
 * browser page, so there is no need for the usual multi-browser project matrix —
 * just a sane timeout and no silent retries hiding a flaky launch.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
});
