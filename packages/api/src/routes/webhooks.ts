/**
 * `/v1/studios/me/webhooks`: the studio's webhook endpoints (issue #760).
 *
 *   | Method | Path               | Chain                                                                       |
 *   |--------|--------------------|-----------------------------------------------------------------------------|
 *   | GET    | /                  | jwtAuth → requireCapability('webhooks.manage') → handler                    |
 *   | POST   | /                  | jwtAuth → requireCapability('webhooks.manage') → zValidator(body) → handler |
 *   | PATCH  | /:id               | jwtAuth → requireCapability('webhooks.manage') → zValidator ×2 → handler    |
 *   | POST   | /:id/rotate-secret | jwtAuth → requireCapability('webhooks.manage') → zValidator → handler       |
 *   | DELETE | /:id               | jwtAuth → requireCapability('webhooks.manage') → zValidator → handler       |
 *
 * The signing secret (`whsec_` + 32 random bytes, base64url) is generated
 * here and returned once, by the creation and the rotation; nothing reads
 * it back (athlya_app has no SELECT on the column). These two routes carry
 * no idempotency replay on purpose: a replay store would keep the secret.
 */

import {
  CreateWebhookEndpointRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookEndpointParamsSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, requireCapability, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type {
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  WebhookEndpoint,
  WebhookEndpointParams,
} from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/** Endpoints a studio may register. */
export const MAX_WEBHOOK_ENDPOINTS = 10;

export interface WebhooksDeps {
  listEndpoints(claims: AuthClaims): Promise<WebhookEndpoint[]>;
  /** `null` when the studio already has {@link MAX_WEBHOOK_ENDPOINTS}. */
  createEndpoint(
    claims: AuthClaims,
    input: CreateWebhookEndpointRequest & { readonly secret: string },
  ): Promise<WebhookEndpoint | null>;
  updateEndpoint(
    claims: AuthClaims,
    id: string,
    patch: UpdateWebhookEndpointRequest & { readonly secret?: string },
  ): Promise<WebhookEndpoint | null>;
  deleteEndpoint(claims: AuthClaims, id: string): Promise<boolean>;
}

/** `whsec_` and 32 random bytes in base64url (43 characters). */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `whsec_${btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}

function problem(c: Context<HonoEnv>, status: 404 | 409, code: string, detail: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: status === 404 ? 'Not Found' : 'Conflict',
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status,
    { 'content-type': 'application/problem+json' },
  );
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) throw new Error('authClaims unexpectedly missing after jwtAuth');
  return claims;
}

export function buildWebhooksRouter(deps: WebhooksDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);
  router.use('*', requireCapability('webhooks.manage'));

  router.get('/', async (c) => {
    traceOperation(c, 'webhooks.list');
    const items = await deps.listEndpoints(claimsOf(c));
    return c.json({ items }, 200, { 'cache-control': 'private, no-store' });
  });

  router.post('/', zValidator('json', CreateWebhookEndpointRequestSchema), async (c) => {
    traceOperation(c, 'webhooks.create');
    const body = readValidated<CreateWebhookEndpointRequest>(c, 'json');
    const secret = newWebhookSecret();
    const endpoint = await deps.createEndpoint(claimsOf(c), { ...body, secret });
    if (endpoint === null) {
      return problem(
        c,
        409,
        'webhook_limit_reached',
        `a studio registers at most ${MAX_WEBHOOK_ENDPOINTS} endpoints`,
      );
    }
    return c.json({ endpoint, secret }, 201, { 'cache-control': 'no-store' });
  });

  router.patch(
    '/:id',
    zValidator('param', WebhookEndpointParamsSchema),
    zValidator('json', UpdateWebhookEndpointRequestSchema),
    async (c) => {
      traceOperation(c, 'webhooks.update');
      const { id } = readValidated<WebhookEndpointParams>(c, 'param');
      const patch = readValidated<UpdateWebhookEndpointRequest>(c, 'json');
      const endpoint = await deps.updateEndpoint(claimsOf(c), id, patch);
      if (endpoint === null) return problem(c, 404, 'webhook_not_found', `no endpoint ${id}`);
      return c.json({ endpoint }, 200);
    },
  );

  router.post('/:id/rotate-secret', zValidator('param', WebhookEndpointParamsSchema), async (c) => {
    traceOperation(c, 'webhooks.rotate-secret');
    const { id } = readValidated<WebhookEndpointParams>(c, 'param');
    const secret = newWebhookSecret();
    const endpoint = await deps.updateEndpoint(claimsOf(c), id, { secret });
    if (endpoint === null) return problem(c, 404, 'webhook_not_found', `no endpoint ${id}`);
    return c.json({ endpoint, secret }, 200, { 'cache-control': 'no-store' });
  });

  router.delete('/:id', zValidator('param', WebhookEndpointParamsSchema), async (c) => {
    traceOperation(c, 'webhooks.delete');
    const { id } = readValidated<WebhookEndpointParams>(c, 'param');
    const deleted = await deps.deleteEndpoint(claimsOf(c), id);
    if (!deleted) return problem(c, 404, 'webhook_not_found', `no endpoint ${id}`);
    return c.body(null, 204);
  });

  return router;
}
