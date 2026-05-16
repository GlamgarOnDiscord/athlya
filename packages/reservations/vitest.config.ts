/**
 * Vitest configuration for `@athlya/reservations`.
 *
 * Co-located unit tests live under `src/__tests__/` and the slower
 * property-based suite lives under `tests/properties/` (kept outside
 * `src/` so the build output tree stays lean). Both trees need to be
 * picked up by a single `vitest run` invocation; the default `include`
 * glob only covers `src/`, so both roots are declared explicitly here.
 *
 * Property-based tests shrink counter-examples on failure, which can
 * add a few seconds per test — `testTimeout` is raised to 30 s to give
 * that headroom without masking a genuine hang.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tests/**/*.property.test.ts'],

    exclude: ['**/node_modules/**', '**/dist/**'],

    // Explicit imports from `vitest`; no globals. Matches the style
    // used across the rest of the monorepo.
    globals: false,

    // Pure Node domain logic — no DOM shim required.
    environment: 'node',

    // Threads keep fast-check's RNG seeding deterministic across
    // runs; the worker pool does not interfere with seeded runs.
    pool: 'threads',

    // Give fast-check enough room to shrink a large counter-example
    // without tripping the default 5 s timeout.
    testTimeout: 30_000,
  },
});
