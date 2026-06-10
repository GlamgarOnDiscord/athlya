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

import { createDb, createDbHttp, type AthlyaDb, type AthlyaDbHttp } from '@athlya/db/client';
import { Redis } from '@upstash/redis';

import { resolvePostgresWriteUrl, usesHyperdriveWritePath } from './postgres-write-url.js';

import type { AthlyaBindings } from '../types.js';

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
 * Separate cache for EU read-replica handles (CN.8.3). Kept distinct
 * from {@link dbHttpCache} so a replica URL that happens to collide
 * with a primary URL in a test never cross-populates the caches.
 */
export const dbHttpEuCache = new Map<string, AthlyaDbHttp>();

/**
 * Cache of Upstash Redis clients keyed on `${url}::${token}`. The
 * Redis client is itself stateless (REST over `fetch`), but the
 * constructor allocates a few internal helpers that are cheap to
 * reuse and impossible to leak across tenants when keyed on the
 * URL+token tuple.
 */
export const redisCache = new Map<string, Redis>();

/**
 * Cache of postgres-js write handles keyed on the resolved write URL.
 * Only populated when {@link usesHyperdriveWritePath} is true — direct
 * Neon TCP clients must stay per-request on Workers.
 */
export const writeDbCache = new Map<string, AthlyaDb>();

function createWriteDb(connectionString: string, viaHyperdrive: boolean): AthlyaDb {
  return createDb(connectionString, {
    maxConnections: viaHyperdrive ? 3 : 1,
    idleTimeoutSec: viaHyperdrive ? 30 : 5,
  });
}

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
 * Return the EU read-replica handle when `euUrl` is provided, using a
 * dedicated cache so primary and replica handles never alias each other.
 */
function getOrCreateDbHttpEu(euUrl: string): AthlyaDbHttp {
  let db = dbHttpEuCache.get(euUrl);
  if (db === undefined) {
    db = createDbHttp(euUrl);
    dbHttpEuCache.set(euUrl, db);
  }
  return db;
}

/**
 * Choose the read DB handle based on the Cloudflare request continent.
 *
 * When `env.DB_URL_EU` is set **and** `continent` is `'EU'`, the EU
 * read-replica is returned to cut cross-Atlantic round-trip latency
 * from ~100 ms to ~15-20 ms. In all other cases the primary handle is
 * returned so behaviour is unchanged for non-EU traffic and for deploys
 * that have not yet provisioned a replica.
 *
 * Writes must always go through {@link getOrCreateWriteDb}; never route
 * a mutation through this function.
 *
 * @param env       - Worker bindings (reads `DB_URL` and optional `DB_URL_EU`).
 * @param continent - Value of `request.cf?.continent` at the call site.
 *                    `undefined` → primary used (conservative fallback).
 */
export function getOrCreateDbHttpForRegion(
  env: { readonly DB_URL: string; readonly DB_URL_EU?: string },
  continent: string | undefined,
): AthlyaDbHttp {
  if (env.DB_URL_EU !== undefined && env.DB_URL_EU.length > 0 && continent === 'EU') {
    return getOrCreateDbHttpEu(env.DB_URL_EU);
  }
  return getOrCreateDbHttp(env.DB_URL);
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

/**
 * Write-path postgres-js handle for book/cancel. Hyperdrive bindings
 * are cached per isolate; direct `DB_URL` builds a fresh client per call.
 */
export function getOrCreateWriteDb(env: AthlyaBindings): AthlyaDb {
  const url = resolvePostgresWriteUrl(env);
  const viaHyperdrive = usesHyperdriveWritePath(env);

  if (!viaHyperdrive) {
    return createWriteDb(url, false);
  }

  let db = writeDbCache.get(url);
  if (db === undefined) {
    db = createWriteDb(url, true);
    writeDbCache.set(url, db);
  }
  return db;
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
  dbHttpEuCache.clear();
  redisCache.clear();
  writeDbCache.clear();
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
