/**
 * `/v1/sessions/*` domain router — task 8.11, issue #652.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path | Chain                                                                                                   |
 *   |--------|------|---------------------------------------------------------------------------------------------------------|
 *   | POST   | /    | jwtAuth → studioRateLimit → projectUserId → zValidator(LogSessionRequestSchema) → idempotency → handler |
 *   | GET    | /me  | jwtAuth → studioRateLimit → zValidator(query: ListSessionsQuerySchema) → handler                        |
 *
 * The per-user mutation bucket of `POST /` (`MUTATION_BUDGETS.session`)
 * is registered by the base app, ahead of this router (issue #613).
 *
 * Requirements:
 *   • 12.1–12.3 — `POST /` validates `exercises.length ≤ 50` and
 *                  `sets.length ≤ 30` per exercise via
 *                  `LogSessionRequestSchema`. The owner and the studio
 *                  come from the JWT: a body `studioId` naming another
 *                  studio is rejected with 422 `studio_mismatch`.
 *   • 12.4       — `GET /me` returns sessions ordered `startedAt DESC`
 *                  within the requested 90-day window.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency. The
 *                  idempotency store is bound per request to the
 *                  caller's claims, because `idempotency_keys` is
 *                  owner-scoped by RLS. That cache is lookup-then-store,
 *                  so the key is also handed to `logSession`, which
 *                  stores it with the session: two racing retries with
 *                  the same key return the same row (migration 0044).
 *   • 18.1 (tasks) — an imported session carries `source` (provider +
 *                  workout id there); a second import of the same
 *                  workout returns the stored row (migration 0047).
 */

import { ListSessionsQuerySchema, LogSessionRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { idempotency, projectUserIdFromClaims, readValidated, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { ListSessionsQuery, LogSessionRequest } from '@athlya/shared/schemas/api';
import type { WorkoutSession } from '@athlya/shared/schemas/domain';
import type { Context, MiddlewareHandler } from 'hono';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/** Result of {@link SessionsDeps.logSession}. */
export type LogSessionOutcome =
  | { readonly kind: 'created'; readonly session: WorkoutSession }
  | { readonly kind: 'studio_mismatch' };

/** Dependencies injected into {@link buildSessionsRouter}. */
export interface SessionsDeps {
  logSession(
    claims: AuthClaims,
    input: LogSessionRequest,
    idempotencyKey?: string,
  ): Promise<LogSessionOutcome>;
  listSessions(
    claims: AuthClaims,
    range: ListSessionsQuery,
  ): Promise<ReadonlyArray<WorkoutSession>>;
  /**
   * Idempotency store bound to the caller's tenant claims, or
   * `undefined` when the environment has none (the mutation then runs
   * without replay protection).
   */
  idempotencyFor?(claims: AuthClaims): IdempotencyMiddlewareDeps | undefined;
}

/** Longest `Idempotency-Key` the idempotency middleware accepts. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** The request `Idempotency-Key`, normalised like the middleware does. */
function idempotencyKeyOf(c: Context<HonoEnv>): string | undefined {
  const key = c.req.header('Idempotency-Key')?.trim();
  return key !== undefined && key.length > 0 && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH
    ? key
    : undefined;
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/sessions/*` sub-router. */
export function buildSessionsRouter(deps: SessionsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  /** Idempotency bound per request to the caller's tenant claims. */
  const idem: MiddlewareHandler<HonoEnv> = async (c, next) => {
    const store = deps.idempotencyFor?.(claimsOf(c));
    if (store === undefined) {
      await next();
      return;
    }
    return idempotency(store)(c, next);
  };

  // Every /v1/sessions route is authenticated.
  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ POST / ------------------------- */
  router.post(
    '/',
    projectUserIdFromClaims(),
    zValidator('json', LogSessionRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'sessions.log');
      const body = readValidated<LogSessionRequest>(c, 'json');
      const outcome = await deps.logSession(claimsOf(c), body, idempotencyKeyOf(c));
      if (outcome.kind === 'studio_mismatch') {
        return c.body(
          JSON.stringify({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: 'studioId must be the studio of the signed-in member',
            code: 'studio_mismatch',
            traceId: c.get('traceId'),
          }),
          422,
          { 'content-type': 'application/problem+json' },
        );
      }
      return c.json(outcome.session, 201);
    },
  );

  /* ------------------------------ GET /me ------------------------ */
  router.get('/me', zValidator('query', ListSessionsQuerySchema), async (c) => {
    traceOperation(c, 'sessions.list-mine');
    const query = readValidated<ListSessionsQuery>(c, 'query');
    const items = await deps.listSessions(claimsOf(c), query);
    return c.json({ items: [...items] }, 200);
  });

  return router;
}
