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

import { studios } from '@athlya/db/schema';
import { eq } from 'drizzle-orm';

import { getOrCreateDbHttp } from './deps-cache.js';

import type { StudioSlugResolver } from '../middleware/tenant-resolver.js';
import type { AthlyaBindings } from '../types.js';

/**
 * Build a {@link StudioSlugResolver} bound to the supplied env.
 *
 * The returned function performs a single
 *
 * ```sql
 * SELECT id FROM studios WHERE slug = $1 LIMIT 1
 * ```
 *
 * and yields `studios.id` on hit, `null` on miss. The query targets a
 * unique index (`studios_slug_unique`) so the read is O(1) on the
 * Postgres side; combined with the 60 s middleware-side cache, the
 * steady-state load is ≤ 1 query per slug per minute regardless of
 * traffic volume.
 *
 * The connection cache from `adapters/deps-cache.ts` ensures we
 * reuse a single Drizzle client across the worker isolate — there is
 * no per-call setup cost beyond the SQL round-trip itself.
 */
export function buildStudioSlugResolver(env: AthlyaBindings): StudioSlugResolver {
  return async (slug) => {
    const db = getOrCreateDbHttp(env.DB_URL);
    const rows = await db
      .select({ id: studios.id })
      .from(studios)
      .where(eq(studios.slug, slug))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : row.id;
  };
}
