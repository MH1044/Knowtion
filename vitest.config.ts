import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Thresholds are set a few points below the numbers measured by
      // `npx vitest run --coverage` at the time this was added (stmts 64.8%, branch
      // 90.0%, funcs 79.9%, lines 64.8%), so this gate starts green and only catches
      // future regressions rather than failing immediately on already-uncovered code
      // (much of the gap is the renderer, main.ts, and CLI scripts, which have no
      // test coverage at all yet — not a regression, just untouched so far).
      thresholds: {
        statements: 60,
        branches: 85,
        functions: 75,
        lines: 60,
      },
    },
  },
});
