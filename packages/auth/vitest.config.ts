/**
 * Vitest configuration for `@athlya/auth`.
 *
 * The package keeps unit tests co-located under `src/**\/__tests__/` (close
 * to the implementation they exercise) and hosts the slower property-based
 * suite under `tests/properties/`. Both trees need to be picked up by a
 * single `vitest run` invocation; the default `include` glob only covers
 * the package root, so we declare both explicitly here.
 *
 * Property-based tests shrink counter-examples on failure, which can add
 * up to a few seconds per test — the `testTimeout` is raised to 30 s to
 * give that headroom without masking genuine hangs.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Covers both co-located unit tests (`src/**/__tests__`) and the
    // property-based suite that lives outside `src/` to keep the
    // build output tree clean.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tests/**/*.property.test.ts'],

    exclude: ['**/node_modules/**', '**/dist/**'],

    // Explicit imports from `vitest`; no globals. Matches the style
    // used across the other packages in the monorepo.
    globals: false,

    // No DOM needed: QR tokens, JWTs and the in-memory replay store
    // are pure Node.
    environment: 'node',

    // Threads keep fast-check's RNG seeding deterministic across
    // runs; the worker pool does not interfere with seeded runs.
    pool: 'threads',

    // Property tests can need a few seconds when shrinking large
    // counter-examples, so give them real headroom.
    testTimeout: 30_000,
  },
});
