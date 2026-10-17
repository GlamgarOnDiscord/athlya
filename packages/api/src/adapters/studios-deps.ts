/**
 * Compose the router-level `StudiosDeps` bundle from a live
 * `AthlyaBindings` env — slice B9.1 + B9.2.
 *
 * Wiring is tiny on purpose: a single Drizzle-backed repo plus the
 * shared HTTP driver cache. No event publishing, no Redis, no
 * idempotency; the two endpoints (`GET` and `PATCH`) are scoped to
 * the caller's own studio and the PATCH already runs through the
 * idempotency middleware composed at the route level.
 *
 * Every query runs under the caller's tenant claims (`withTenantHttp`,
 * issue #224): `studios` is FORCE RLS and a claim-less query sees no
 * row under the `athlya_app` runtime role.
 *
 * @see Requirements 13.2, 15.2 (brand color), 13.5 (no cross-tenant
 *      disclosure).
 */

import { getOrCreateDbHttp } from './deps-cache.js';
import { createDrizzleStudioRepoHttp, type StudioRepo } from './studios-repo-drizzle.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { StudiosDeps } from '../routes/studios.js';
import type { AthlyaBindings } from '../types.js';
import type { TenantClaims } from '@athlya/db/client';

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

/**
 * Produce the {@link StudiosDeps} bundle consumed by
 * {@link buildStudiosRouter}. Each method pulls the shared HTTP
 * Drizzle handle from the per-isolate cache and builds the
 * lightweight tenant-scoped repo fresh per call.
 */
export function buildStudiosDeps(env: AthlyaBindings): StudiosDeps {
  const repoFor = (claims: AuthClaims): StudioRepo =>
    createDrizzleStudioRepoHttp(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims));

  return {
    async getStudio(studioId, claims) {
      return repoFor(claims).getById(studioId);
    },

    async updateStudio(studioId, patch, claims) {
      return repoFor(claims).updateById(studioId, patch);
    },
  };
}
