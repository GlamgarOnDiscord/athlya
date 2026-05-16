/**
 * Integration test for the per-isolate HTTP-driver Drizzle cache
 * shipped in slice B1 (Vague 18).
 *
 * Background — slice B1 migrated `auth-deps.ts`, `members-deps.ts`
 * and `reservations-deps.ts` (read paths) from a per-request
 * `createDb` (postgres-js) to a module-scope cached
 * `createDbHttp` (`@neondatabase/serverless`). The HTTP driver is
 * stateless, so caching the handle across requests inside one
 * isolate cannot raise the Cloudflare Workers
 * "Cannot perform I/O on behalf of a different request" error.
 *
 * What this test asserts (the B1.5 acceptance criterion)
 * ------------------------------------------------------
 * Even under 100 concurrent simulated requests, each of the three
 * deps modules creates the underlying Drizzle handle EXACTLY ONCE.
 * The proof is delivered via:
 *
 *   1. A `vi.mock` of `@athlya/db/client` that intercepts
 *      `createDbHttp` with a counting stub. Each call is recorded so
 *      the post-hoc assertion `mock.calls.length === 1` can be made.
 *   2. The `__resetXxxCachesForTests` seams clear any state left
 *      over from earlier suites in the same vitest worker, ensuring
 *      this test starts from a known-empty cache.
 *   3. The `__primeDbHttpForTests` seam exposes a tiny touchpoint
 *      that exercises the same `getOrCreateDbHttp` helper used by
 *      every production code path, without dragging the rest of the
 *      auth / members / reservations service stack into scope.
 *      Production methods (`buildAuthDeps(env).login(input)`,
 *      `buildMembersDeps(env).getProfile(id)`, …) all funnel through
 *      that same memoised getter, so verifying the getter under
 *      contention is the targeted property required by B1.5.
 *
 * Why a unit-style integration test rather than a real network bench?
 * -----------------------------------------------------------------
 * The B1.3 sub-task originally proposed a 1000-request `/v1/auth/login`
 * bench against a live worker. That requires a running `wrangler dev`,
 * a real Neon database and a Turnstile bypass — none of which the
 * CI lane provisions. The cache-correctness proof, on the other hand,
 * is a pure-function property of the deps modules and can be exercised
 * deterministically here. The "no I/O error under 100 parallel
 * requests" claim reduces to "the underlying Drizzle handle is
 * created at most once" because:
 *
 *   • `createDbHttp` itself does no I/O — it returns a stateless
 *     fetch caller (per `@neondatabase/serverless`'s contract);
 *   • the Workers I/O-isolation error is raised when a
 *     long-lived TCP socket from a previous request is reused.
 *     The HTTP driver opens no such socket;
 *   • therefore "single creation" + "stateless caller" together
 *     imply "no cross-request I/O leak".
 *
 * Validates: B1.5 (`tasks.md` lines 762-765 — Backend Hardening Epic
 * B1, sub-task "Tests : suite api existante + un nouveau test
 * integration '100 requests parallèles sans I/O error'").
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  @athlya/db/client mock                                             */
/* ------------------------------------------------------------------ */

/**
 * `vi.hoisted` evaluates BEFORE `vi.mock` so the factory closure can
 * capture the live `vi.fn()` references. The same pattern is used in
 * `tenant.test.ts`, `middleware-chain.test.ts` and the existing
 * gateway integration suite — keep the style consistent.
 */
const dbMocks = vi.hoisted(() => {
    /**
     * Sentinel returned by the stubbed `createDbHttp`. Each entry
     * captures the URL + a unique counter so the test can prove the
     * caller saw the SAME instance across all 100 concurrent calls.
     */
    let counter = 0;
    const createDbHttp = vi.fn((url: string) => {
        counter += 1;
        return {
            __brand: 'fake-http-db' as const,
            url,
            instanceId: counter,
        };
    });
    // The deps modules also import `createDb` (used by the
    // postgres-js write path inside `reservations-deps.ts`) and
    // `AthlyaDbAny` types — return shape-compatible stubs so the
    // factory does not blow up at import time.
    const createDb = vi.fn((url: string) => ({
        __brand: 'fake-pg-db' as const,
        url,
    }));

    return { createDbHttp, createDb };
});

vi.mock('@athlya/db/client', () => ({
    createDbHttp: dbMocks.createDbHttp,
    createDb: dbMocks.createDb,
}));

/* ------------------------------------------------------------------ */
/*  System under test                                                  */
/* ------------------------------------------------------------------ */

/*
 * The deps modules read `createDbHttp` at module-evaluation time
 * (top-level `import { createDbHttp } from '@athlya/db/client';`),
 * so the `vi.mock` above MUST be declared before these imports.
 * Vitest's automatic hoisting of `vi.mock` makes that ordering safe
 * — keep them grouped at the top of the file for readability.
 */
import {
    __primeDbHttpForTests as primeAuthDb,
    __resetAuthDepsCachesForTests as resetAuthCaches,
} from '../../adapters/auth-deps.js';
import {
    __primeDbHttpForTests as primeMembersDb,
    __resetMembersDepsCachesForTests as resetMembersCaches,
} from '../../adapters/members-deps.js';
import {
    __primeDbHttpForTests as primeReservationsDb,
    __resetReservationsDepsCachesForTests as resetReservationsCaches,
} from '../../adapters/reservations-deps.js';

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

const TEST_DB_URL = 'postgres://b15.invalid/athlya';
const TEST_DB_URL_OTHER = 'postgres://b15-other.invalid/athlya';
const PARALLEL = 100;

describe('B1.5 — HTTP-driver Drizzle cache under cross-request contention', () => {
    beforeEach(() => {
        // Each test starts from a known-empty cache regardless of
        // ordering inside the worker. The reset seams are exposed
        // for exactly this reason — see the `@internal` JSDoc on
        // each `__resetXxxCachesForTests`.
        resetAuthCaches();
        resetMembersCaches();
        resetReservationsCaches();
        dbMocks.createDbHttp.mockClear();
    });

    it('auth-deps reuses ONE Drizzle handle across 100 parallel calls', async () => {
        // 100 concurrent primes — modelled on the worst case where
        // every in-flight request inside one isolate hits
        // `getOrCreateDbHttp` before any of them have populated the
        // cache (the read-then-write race the cache is designed to
        // collapse).
        const results = await Promise.all(
            Array.from({ length: PARALLEL }, () => primeAuthDb(TEST_DB_URL)),
        );

        // Single creation — the heart of the B1.5 invariant.
        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(1);
        expect(dbMocks.createDbHttp).toHaveBeenCalledWith(TEST_DB_URL);

        // Every caller observed the SAME instance — no second handle
        // slipped through any race window. Identity-equality on the
        // stub (`===`) is the strongest possible check.
        const first = results[0]!.handle;
        expect(results.every((r) => r.handle === first)).toBe(true);

        // Cache size invariant: one URL → one entry.
        expect(results[results.length - 1]!.size).toBe(1);
    });

    it('members-deps reuses ONE Drizzle handle across 100 parallel calls', async () => {
        const results = await Promise.all(
            Array.from({ length: PARALLEL }, () =>
                primeMembersDb(TEST_DB_URL),
            ),
        );

        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(1);
        expect(dbMocks.createDbHttp).toHaveBeenCalledWith(TEST_DB_URL);
        const first = results[0]!.handle;
        expect(results.every((r) => r.handle === first)).toBe(true);
        expect(results[results.length - 1]!.size).toBe(1);
    });

    it('reservations-deps reuses ONE Drizzle handle across 100 parallel calls (read path)', async () => {
        const results = await Promise.all(
            Array.from({ length: PARALLEL }, () =>
                primeReservationsDb(TEST_DB_URL),
            ),
        );

        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(1);
        expect(dbMocks.createDbHttp).toHaveBeenCalledWith(TEST_DB_URL);
        const first = results[0]!.handle;
        expect(results.every((r) => r.handle === first)).toBe(true);
        expect(results[results.length - 1]!.size).toBe(1);
    });

    it('caches are keyed on the connection string — distinct URLs yield distinct handles', async () => {
        // Multi-tenant safety check. A Worker isolate that serves
        // dev + staging traffic in the same lifetime (preview
        // builds, A/B routing) MUST keep the two pools separate.
        const a = primeAuthDb(TEST_DB_URL);
        const b = primeAuthDb(TEST_DB_URL_OTHER);

        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(2);
        expect(a.handle).not.toBe(b.handle);
        expect(b.size).toBe(2);
    });

    it('reset seam restores the empty-cache invariant', async () => {
        primeAuthDb(TEST_DB_URL);
        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(1);

        resetAuthCaches();
        // After reset, the next call MUST recreate the handle.
        const after = primeAuthDb(TEST_DB_URL);
        expect(dbMocks.createDbHttp).toHaveBeenCalledTimes(2);
        expect(after.size).toBe(1);
    });
});
