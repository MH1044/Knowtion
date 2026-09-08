// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Determinism rules.
 *
 * The sync engine is tested by a deterministic simulator that replays any failure
 * from its seed. That is impossible if code reaches for ambient state, so ambient
 * non-determinism is banned inside packages/ and injected instead: Clock, Random,
 * IdGen, Storage.
 *
 * This is deliberately a week-one rule. Adding it later is a multi-week refactor,
 * and until it exists the simulator cannot reproduce anything.
 */
const noAmbientNonDeterminism = [
  {
    selector: "CallExpression > MemberExpression[object.name='Date'][property.name='now']",
    message:
      'Date.now() is banned in packages/. Inject a Clock so the simulator can replay ' +
      'failures deterministically.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'new Date() with no arguments is banned in packages/. Inject a Clock so the ' +
      'simulator can replay failures deterministically.',
  },
  {
    selector: "CallExpression > MemberExpression[object.name='Math'][property.name='random']",
    message:
      'Math.random() is banned in packages/. Inject a seeded Random so the simulator ' +
      'can replay failures deterministically.',
  },
  {
    selector: "CallExpression > MemberExpression[object.name='crypto'][property.name='randomUUID']",
    message:
      'crypto.randomUUID() is banned in packages/. Inject an IdGen; IDs must be ' +
      'reproducible from a seed, and Knowtion uses UUIDv7 with a monotonic counter.',
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message:
      'Real timers are banned in packages/. Inject a Clock with a virtual timer so the ' +
      'simulator can advance time without waiting.',
  },
  {
    selector: "CallExpression[callee.name='setInterval']",
    message: 'Real timers are banned in packages/. Inject a Clock with a virtual timer.',
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'packages/format/fixtures/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // The engine must stay headless. If packages/ can reach into apps/, the boundary
  // that keeps a second host shell possible is gone, and it goes quietly.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...noAmbientNonDeterminism],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/*', '@knowtion/desktop', '@knowtion/desktop/*'],
              message:
                'packages/ must never import from apps/. The engine is headless so it ' +
                'can be tested without Electron and hosted by a different shell later.',
            },
            {
              group: ['electron', 'electron/*'],
              message:
                'packages/ must never import Electron. Pass host capabilities in ' +
                'through an injected adapter instead.',
            },
          ],
        },
      ],
    },
  },

  // Build and maintenance scripts run in Node, outside the engine's determinism rules.
  {
    files: ['scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs', '*.config.js', '*.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Tests may use real timers and ambient randomness where they are the subject.
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
