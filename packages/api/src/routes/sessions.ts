/**
 * `/v1/sessions/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path | Chain                                                                   |
 *   |--------|------|-------------------------------------------------------------------------|
 *   | POST   | /    | jwtAuth → projectUserId → zValidator(LogSessionRequestSchema) → idempotency → handler |
 *   | GET    | /me  | jwtAuth → zValidator(query: ListSessionsQuerySchema) → handler          |
 *
 * Requirements:
 *   • 12.1–12.3 — `POST /` validates `exercises.length ≤ 50` and
 *                  `sets.length ≤ 30` per exercise via
 *                  `LogSessionRequestSchema`.
 *   • 12.4       — `GET /me` returns sessions ordered `startedAt DESC`
 *                  within the requested 90-day window.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 */

import { ListSessionsQuerySchema, LogSessionRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { idempotency, projectUserIdFromClaims, readValidated, traceOperation } from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { ListSessionsQuery, LogSessionRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/** Dependencies injected into {@link buildSessionsRouter}. */
export interface SessionsDeps {
  logSession(userId: string, input: LogSessionRequest): Promise<unknown>;
  listSessions(userId: string, range: ListSessionsQuery): Promise<ReadonlyArray<unknown>>;

  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/sessions/*` sub-router. */
export function buildSessionsRouter(deps: SessionsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  // Every /v1/sessions route is authenticated.
  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ POST / ------------------------- */
  router.post(
    '/',
    projectUserIdFromClaims(),
    zValidator('json', LogSessionRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'sessions.log');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<LogSessionRequest>(c, 'json');
      const session = await deps.logSession(claims.userId, body);
      return c.json(session as Record<string, unknown>, 201);
    },
  );

  /* ------------------------------ GET /me ------------------------ */
  router.get('/me', zValidator('query', ListSessionsQuerySchema), async (c) => {
    traceOperation(c, 'sessions.list-mine');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const query = readValidated<ListSessionsQuery>(c, 'query');
    const items = await deps.listSessions(claims.userId, query);
    return c.json({ items: [...items] as unknown[] }, 200);
  });

  return router;
}
