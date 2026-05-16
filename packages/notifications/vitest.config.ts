/**
 * Vitest configuration for `@athlya/notifications`.
 *
 * Co-located unit tests live under `src/__tests__/`. The consumer is a
 * pure function over injected ports — there are no property-based
 * suites yet (fast-check is installed in case task 9.7 adds one), so
 * only the `src/` tree is wired up here.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],

        exclude: ['**/node_modules/**', '**/dist/**'],

        // Explicit imports from `vitest`; no globals. Matches the style
        // used across the rest of the monorepo.
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
