/**
 * `/v1/me/*` router — the caller's own derived views (Epic 22).
 *
 *   | Method | Path         | Chain                                                       |
 *   |--------|--------------|-------------------------------------------------------------|
 *   | GET    | /progression | jwtAuth → studioRateLimit → zValidator(query) → handler     |
 *
 * `GET /progression?window=30|90|365` returns the per-exercise volume
 * and estimated 1RM trends plus the weekly session frequency computed
 * by `@athlya/members/progression` (task 22.1). The gateway also
 * applies the fail-closed expensive-read limiter to this path
 * (`base-app.ts`, coverage row `progression-read`).
 *
 * Caching: the window is made of whole UTC days, so the body only
 * changes within a day when the member logs a session. The handler
 * sends a strong ETag over the body and answers a matching
 * `If-None-Match` with 304; `Cache-Control: private` keeps shared
 * caches out of it.
 */

import { ProgressionQuerySchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { computeListEtag, readValidated, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { ProgressionQuery, ProgressionWindow } from '@athlya/shared/schemas/api';

/** Dependencies injected into {@link buildMeRouter}. */
export interface MeDeps {
  getProgression(
    userId: string,
    windowDays: ProgressionWindow,
    claims: AuthClaims,
  ): Promise<unknown>;
}

/** `Cache-Control` of `GET /v1/me/progression`. */
export const PROGRESSION_CACHE_CONTROL = 'private, max-age=60, must-revalidate';

/**
 * True when an `If-None-Match` header matches `etag` (RFC 9110 §13.1.2):
 * `*`, or any entry of the comma-separated list, compared weakly.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = header.trim();
  if (value === '*') return true;
  return value
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(etag);
}

/** Build the `/v1/me/*` sub-router. */
export function buildMeRouter(deps: MeDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/progression', zValidator('query', ProgressionQuerySchema), async (c) => {
    traceOperation(c, 'members.progression');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const query = readValidated<ProgressionQuery>(c, 'query');
    const windowDays = Number(query.window) as ProgressionWindow;
    const body = JSON.stringify(await deps.getProgression(claims.userId, windowDays, claims));

    const etag = await computeListEtag(body);
    c.header('etag', etag);
    c.header('cache-control', PROGRESSION_CACHE_CONTROL);
    c.header('vary', 'authorization');
    if (ifNoneMatchHits(c.req.header('if-none-match'), etag)) {
      return c.body(null, 304);
    }
    return c.body(body, 200, { 'content-type': 'application/json' });
  });

  return router;
}
