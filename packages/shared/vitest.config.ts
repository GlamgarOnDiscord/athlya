/**
 * Vitest configuration for `@athlya/shared`.
 *
 * This config is intentionally scoped to this package — the monorepo
 * does not run tests from the root, each package drives its own Vitest
 * invocation through its `test` script (`vitest run`).
 *
 * Property-based tests can be slow to shrink on failure, so the
 * timeout is bumped to 30 s per test. All other knobs stay conservative.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pick up both plain unit tests and property tests. Keeping the two
    // patterns separate makes it easy to glob one set from CI later.
    // `src/**/*.test.ts` covers co-located single-file modules (see
    // `src/theming/brand-color.test.ts` for the first user).
    include: ['tests/**/*.test.ts', 'tests/**/*.property.test.ts', 'src/**/*.test.ts'],

    // Standard ignores; nothing task-specific belongs here.
    exclude: ['**/node_modules/**', '**/dist/**'],

    // We prefer explicit imports from `vitest` over globals so every
    // test file is self-describing and lintable by `import/order`.
    globals: false,

    // Node-only; nothing in `@athlya/shared` touches the DOM.
    environment: 'node',

    // Threads give stable isolation for fast-check's RNG seeding.
    pool: 'threads',

    // Property tests can take a few seconds when shrinking large
    // counter-examples, so give them headroom.
    testTimeout: 30_000,

    // Coverage config is declared here for future use; we don't
    // enable coverage in CI yet (no `--coverage` flag in the test
    // script) so this is a no-op until explicitly requested.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
    },
  },
});
