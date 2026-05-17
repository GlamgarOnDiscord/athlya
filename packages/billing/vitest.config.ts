/**
 * Vitest configuration for `@athlya/billing`.
 *
 * Co-located unit tests live under `src/__tests__/`. The service is a
 * pure function over injected ports — fast-check is installed for a
 * future property suite (e.g. metadata round-tripping), but none is
 * wired yet, so only the `src/` tree is collected here.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],

    exclude: ['**/node_modules/**', '**/dist/**'],

    // Explicit imports from `vitest`; no globals. Matches the
    // style used across the rest of the monorepo.
    globals: false,

    // Pure Node domain logic — no DOM shim required.
    environment: 'node',

    // Threads keep fast-check's RNG seeding deterministic across
    // runs; the worker pool does not interfere with seeded runs.
    pool: 'threads',

    // Headroom for future property tests; unit tests finish in
    // milliseconds.
    testTimeout: 30_000,
  },
});
