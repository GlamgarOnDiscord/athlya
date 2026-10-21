/**
 * `/v1/studios/me/settings`: the studio's settings (issue #759).
 *
 *   | Method | Path | Chain                                                      |
 *   |--------|------|------------------------------------------------------------|
 *   | GET    | /    | jwtAuth → requireRole('admin') → handler                   |
 *   | PATCH  | /    | jwtAuth → requireRole('admin') → zValidator(body) → handler |
 *
 * Name, IANA time zone, postal address and contact email. The write runs
 * under the `studios_admin_update_own` policy with the column grant of
 * migration 0055, scoped to `claims.studioId`. Mounted under the studios
 * prefix so it reaches the same Worker as `/v1/studios/*`.
 */

import { UpdateStudioSettingsRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, requireRole, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { StudioSettings, UpdateStudioSettingsRequest } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

export interface StudioSettingsDeps {
  getSettings(claims: AuthClaims): Promise<StudioSettings | null>;
  updateSettings(
    claims: AuthClaims,
    patch: UpdateStudioSettingsRequest,
  ): Promise<StudioSettings | null>;
}

function notFound(c: Context<HonoEnv>): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'studio not found',
      code: 'not_found',
      traceId: c.get('traceId'),
    }),
    404,
    { 'content-type': 'application/problem+json' },
  );
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) throw new Error('authClaims unexpectedly missing after jwtAuth');
  return claims;
}

export function buildStudioSettingsRouter(deps: StudioSettingsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/', requireRole('admin'), async (c) => {
    traceOperation(c, 'studios.settings.get');
    const settings = await deps.getSettings(claimsOf(c));
    if (settings === null) return notFound(c);
    return c.json(settings, 200, { 'cache-control': 'private, no-store' });
  });

  router.patch(
    '/',
    requireRole('admin'),
    zValidator('json', UpdateStudioSettingsRequestSchema),
    async (c) => {
      traceOperation(c, 'studios.settings.update');
      const patch = readValidated<UpdateStudioSettingsRequest>(c, 'json');
      const settings = await deps.updateSettings(claimsOf(c), patch);
      if (settings === null) return notFound(c);
      return c.json(settings, 200);
    },
  );

  return router;
}
