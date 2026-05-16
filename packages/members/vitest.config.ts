/**
 * Vitest configuration for `@athlya/members`.
 *
 * Two shapes of tests live in this package:
 *
 *   1. Co-located unit tests under `src/**\/__tests__/` (service,
 *      consents, sessions, export, cascade, validators). They stub
 *      every port with `vi.fn()` doubles, run in milliseconds and
 *      don't touch the network.
 *   2. Integration tests under `tests/integration/` that need a real
 *      Postgres 17 instance spun up by Testcontainers. Task 5.6's
 *      RGPD deletion cascade test (Property 4) is the first member of
 *      this family — `tests/integration/cascade.integration.test.ts`.
 *      It self-skips when Docker is unreachable so `pnpm test` stays
 *      green on contributors' machines without a running daemon.
 *
 * Timeout budget:
 *   Unit tests finish in milliseconds; the integration suite spends
 *   most of its wall clock on `docker run` + migration bootstrap
 *   (~20–30 s on a warm Docker daemon, up to 60 s on a cold CI
 *   runner). 180 s keeps headroom for the slowest CI image without
 *   masking genuine hangs.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Covers the co-located unit suites AND the new integration
        // tree under `tests/`. Both globs are required because each
        // tree carries a distinct shape of assertions (pure-domain vs
        // full-DB) and the package build pipeline excludes `tests/`
        // from the published `dist/`.
        include: [
            'src/**/__tests__/**/*.test.ts',
            'src/**/*.test.ts',
            'tests/**/*.test.ts',
        ],

        exclude: ['**/node_modules/**', '**/dist/**'],

        // Explicit imports from `vitest`; no globals. Matches the
        // style used across the rest of the monorepo.
        globals: false,

        // Pure Node domain logic + Testcontainers — no DOM shim.
        environment: 'node',

        // Threads keep fast-check's RNG seeding deterministic across
        // runs and don't interfere with the shared Testcontainers
        // container spun up in a `beforeAll`.
        pool: 'threads',

        // Testcontainers-backed integration suite pays a container
        // startup tax. 180 s accommodates the slowest CI runner we
        // target without hiding genuine hangs.
        testTimeout: 180_000,
        hookTimeout: 180_000,
    },
});
