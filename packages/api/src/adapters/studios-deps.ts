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
 * @see Requirements 13.2, 15.2 (brand color), 13.5 (no cross-tenant
 *      disclosure).
 */

import { getOrCreateDbHttp } from './deps-cache.js';
import { createDrizzleStudioRepo, type StudioRepo } from './studios-repo-drizzle.js';

import type { StudiosDeps } from '../routes/studios.js';
import type { AthlyaBindings } from '../types.js';

/**
 * Produce the {@link StudiosDeps} bundle consumed by
 * {@link buildStudiosRouter}. Each method pulls the shared HTTP
 * Drizzle handle from the per-isolate cache and builds the
 * lightweight repo wrapper fresh per call.
 */
export function buildStudiosDeps(env: AthlyaBindings): StudiosDeps {
  return {
    async getStudio(studioId) {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo: StudioRepo = createDrizzleStudioRepo(db);
      return repo.getById(studioId);
    },

    async updateStudio(studioId, patch) {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo: StudioRepo = createDrizzleStudioRepo(db);
      return repo.updateById(studioId, patch);
    },
  };
}
