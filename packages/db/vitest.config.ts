/**
 * Vitest configuration for `@athlya/db`.
 *
 * The package hosts two categories of tests:
 *
 *   1. Fast unit tests under `tests/*.test.ts` (client, idempotency,
 *      outbox) that stub drizzle's transaction boundary and run in
 *      milliseconds.
 *   2. Property-based integration tests under `tests/properties/**` that
 *      need a real Postgres 17 with the 0000/0001 migrations applied.
 *      The RLS property test (task 2.7) spins one up through
 *      Testcontainers, which adds ~20–30 s of startup on a warm Docker
 *      daemon — hence the generous `testTimeout` below.
 *
 * When Docker is not reachable the RLS property suite self-skips via
 * an `it.skipIf(...)` guard (see `tests/properties/rls.property.test.ts`),
 * so `pnpm test` still runs cleanly on machines without Docker.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Covers the vanilla unit suite at the package root plus the
    // property-based suite under `tests/properties/`. Both shapes
    // live outside `src/` to keep the compiled `dist/` tree clean.
    include: ['tests/**/*.test.ts', 'tests/**/*.property.test.ts'],

    exclude: ['**/node_modules/**', '**/dist/**'],

    // Explicit imports from `vitest`; no globals. Matches the style
    // used across the other packages in the monorepo.
    globals: false,

    // All tests run against Node (postgres-js + testcontainers).
    environment: 'node',

    // Threads keep fast-check's RNG seeding deterministic across
    // runs; the worker pool does not interfere with seeded runs.
    pool: 'threads',

    // Testcontainers-backed tests spend most of their wall clock on
    // `docker run` + migration bootstrap. 120 s accommodates the
    // slowest CI runner we target without masking genuine hangs.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
