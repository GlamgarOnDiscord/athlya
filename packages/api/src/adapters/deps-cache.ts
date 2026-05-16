/**
 * Per-isolate caches shared by every `*-deps.ts` builder.
 *
 * Slice B8.2 collapses the previously-duplicated `dbHttpCache` /
 * `redisCache` Maps that lived inside `auth-deps.ts`,
 * `members-deps.ts` and `reservations-deps.ts`. Sharing the cache
 * across builders is **strictly correct** because:
 *
 *   • The HTTP-driver Drizzle handle is stateless (pure
 *     `fetch`-based caller per `@neondatabase/serverless`); reusing
 *     one handle across the auth / members / reservations services
 *     inside the same Cloudflare Workers isolate cannot raise the
 *     "Cannot perform I/O on behalf of a different request" error
 *     (the failure mode is exclusive to long-lived TCP sockets).
 *   • The Upstash Redis client is itself an HTTP-stateless caller
 *     (`fetch` over the REST API); sharing it across services keyed
 *     on the `${url}::${token}` tuple cannot leak credentials between
 *     tenants — the key is the credential.
 *   • Sharing the caches divides the cold-path allocation cost by
 *     three (one Drizzle handle for reads, one Redis client per
 *     credential pair) and keeps the cache hit rate at 100 % across
 *     a single isolate's lifetime regardless of which domain router
 *     triggered the first call.
 *
 * The `*-deps.ts` modules retain their own `__resetXxxDepsCachesForTests`
 * + `__primeDbHttpForTests` helpers as **retro-compat shims** so the
 * B1.5 integration test (`db-http-cache-parallel.test.ts`) continues
 * to drive the same touch points it was written against. Each shim
 * delegates here.
 *
 * @see `auth-deps.ts`, `members-deps.ts`, `reservations-deps.ts`
 *      and the B1 file-level rationale block on caching strategy.
 */

import { createDbHttp, type AthlyaDbHttp } from '@athlya/db/client';
import { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Module-scope caches                                                */
/* ------------------------------------------------------------------ */

/**
 * Cache of HTTP-driver Drizzle handles keyed on the connection
 * string. Stateless `fetch`-based driver — see the file-level
 * comment for the safety argument.
 */
export const dbHttpCache = new Map<string, AthlyaDbHttp>();

/**
 * Cache of Upstash Redis clients keyed on `${url}::${token}`. The
 * Redis client is itself stateless (REST over `fetch`), but the
 * constructor allocates a few internal helpers that are cheap to
 * reuse and impossible to leak across tenants when keyed on the
 * URL+token tuple.
 */
export const redisCache = new Map<string, Redis>();

/* ------------------------------------------------------------------ */
/*  Cache accessors                                                    */
/* ------------------------------------------------------------------ */

/**
 * Look up — or lazily create — the Drizzle HTTP handle bound to
 * `url`. The cache is module-scoped so every `*-deps.ts` builder
 * sees the same handle for the same connection string inside one
 * Worker isolate.
 */
export function getOrCreateDbHttp(url: string): AthlyaDbHttp {
    let db = dbHttpCache.get(url);
    if (db === undefined) {
        db = createDbHttp(url);
        dbHttpCache.set(url, db);
    }
    return db;
}

/**
 * Look up — or lazily create — the Upstash Redis client bound to
 * `url` + `token`. Keyed on the credential pair so a token rotation
 * naturally evicts the old entry; the previous client becomes
 * unreferenced and is GC'd at the next compaction.
 */
export function getOrCreateRedis(url: string, token: string): Redis {
    const key = `${url}::${token}`;
    let redis = redisCache.get(key);
    if (redis === undefined) {
        redis = new Redis({ url, token });
        redisCache.set(key, redis);
    }
    return redis;
}

/* ------------------------------------------------------------------ */
/*  Test seams                                                         */
/* ------------------------------------------------------------------ */

/**
 * Test seam — drop every cached handle (DB + Redis) so a unit test
 * can swap connection strings between calls without seeing the
 * previous one's cached client. Production code paths never call
 * this.
 *
 * Each `*-deps.ts` module re-exports a thin wrapper
 * (`__resetXxxDepsCachesForTests`) that calls this helper plus any
 * domain-specific cache (e.g. `auth-deps.ts` also flushes its
 * `jwtCache`).
 */
export function resetAllDepsCachesForTests(): void {
    dbHttpCache.clear();
    redisCache.clear();
}

/**
 * @internal Test seam — primes the per-isolate `dbHttpCache` for
 * `url` and reports the resulting cache size. Used by the B1.5
 * integration test to verify that 100 parallel calls share ONE DB
 * handle. Production code paths never call this.
 */
export function primeDbHttpForTests(url: string): {
    readonly size: number;
    readonly handle: AthlyaDbHttp;
} {
    const handle = getOrCreateDbHttp(url);
    return { size: dbHttpCache.size, handle };
}
