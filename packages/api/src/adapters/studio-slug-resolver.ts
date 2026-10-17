/**
 * Slug → studio.id lookup adapter for the tenant claim guard
 * (Slice 1.4 — Sprint 1 — SP1.5, audit finding S2-007).
 *
 * The middleware in `middleware/tenant-resolver.ts` cross-checks the
 * tenant slug resolved from the host/path against the JWT `studio`
 * claim. To do that, it needs to translate `slug → studioId` against
 * the live `studios` table. This adapter is the binding between that
 * abstract `StudioSlugResolver` contract and the concrete Drizzle +
 * Postgres-over-HTTP wiring already used by every other domain
 * adapter (`auth-deps.ts`, `members-deps.ts`, `cascade-deps.ts`, …).
 *
 * Why a separate module?
 * ----------------------
 * Keeping the lookup outside of `worker.ts` lets the gateway file
 * stay free of `@athlya/db` / `drizzle-orm` imports. The pattern
 * mirrors `cascade-deps.ts` and `export-deps.ts` — domain-specific
 * adapters live under `src/adapters/`, the wiring layer in
 * `worker.ts` stays composition-only.
 *
 * Connection caching — `getOrCreateDbHttp(url)` reuses the same
 * pooled `AthlyaDbHttp` instance per `DB_URL` across the worker
 * isolate (see `adapters/deps-cache.ts`), so repeated lookups never
 * pay client-construction cost.
 *
 * RLS — the lookup goes through the `studio_id_by_slug` service
 * function (migration 0038, issue #224); a raw `studios` query sees no
 * row under the `athlya_app` runtime role.
 *
 * Result caching is the responsibility of the middleware itself
 * (60 s TTL `Map<slug, studioId>` keyed by the same `DB_URL` string
 * we feed here), so this adapter is intentionally cache-agnostic.
 *
 * Errors thrown here propagate to the middleware which interprets
 * them as fail-open signals (DB outage → log warn + let through).
 * The contract for an unknown slug is `null`, NOT a thrown error —
 * a thrown error is reserved for "infrastructure unavailable".
 *
 * @see Requirements 13.1, 13.2, 13.5.
 */

import { getOrCreateDbHttp } from './deps-cache.js';
import { queryRows, serviceFn } from './service-functions.js';

import type { StudioSlugResolver } from '../middleware/tenant-resolver.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbAny } from '@athlya/db/client';

/**
 * Build a {@link StudioSlugResolver} over `db`.
 *
 * The lookup runs before any tenant context exists, so it cannot query
 * `studios` directly: the table is FORCE RLS and its read policy keys on
 * `app_studio_id()`, which matches nothing under the `athlya_app` role
 * (issue #224). It calls the `studio_id_by_slug` SECURITY DEFINER
 * function instead (migration 0038), which returns the id of the live
 * studio with that slug, or `NULL`. The function hits the
 * `studios_slug_unique` index; combined with the 60 s middleware-side
 * cache, the steady-state load is at most one query per slug per minute.
 */
export function createStudioSlugResolver(db: AthlyaDbAny): StudioSlugResolver {
  return async (slug) => {
    const rows = await queryRows<{ id: string | null }>(db, serviceFn.studioIdBySlug(slug));
    return rows[0]?.id ?? null;
  };
}

/**
 * Build a {@link StudioSlugResolver} bound to the supplied env. The
 * connection cache from `adapters/deps-cache.ts` reuses a single Drizzle
 * client across the worker isolate.
 */
export function buildStudioSlugResolver(env: AthlyaBindings): StudioSlugResolver {
  return (slug) => createStudioSlugResolver(getOrCreateDbHttp(env.DB_URL))(slug);
}
