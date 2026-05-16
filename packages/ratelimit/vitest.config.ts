/**
 * Vitest configuration for `@athlya/ratelimit`.
 *
 * The package hosts its unit tests and property-based suite under
 * `tests/`:
 *
 *   - `tests/sliding-window.test.ts`           — unit tests.
 *   - `tests/properties/ratelimit.property.test.ts` — Property 8
 *     (Sliding-Window Exactness).
 *
 * Both trees need to be picked up by a single `vitest run` invocation;
 * the default `include` glob only covers the package root, so we
 * declare both explicitly here.
 *
 * Property-based tests shrink counter-examples on failure, which can
 * add up to a few seconds per test — the `testTimeout` is raised to
 * 30 s to give that headroom without masking genuine hangs.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [
            'tests/**/*.test.ts',
            'tests/**/*.property.test.ts',
        ],

        exclude: ['**/node_modules/**', '**/dist/**'],

        // Explicit imports from `vitest`; no globals. Matches the style
        // used across the other packages in the monorepo.
        globals: false,

        // No DOM needed: the limiter and its fakes are pure Node.
        environment: 'node',

        // Threads keep fast-check's RNG seeding deterministic across
        // runs; the worker pool does not interfere with seeded runs.
        pool: 'threads',

        // Property tests can need a few seconds when shrinking large
        // counter-examples, so give them real headroom.
        testTimeout: 30_000,
    },
});
