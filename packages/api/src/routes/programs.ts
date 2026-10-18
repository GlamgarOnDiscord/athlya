/**
 * `/v1/programs/*` domain router — Epic 24 (tasks 24.2), issue #640.
 *
 *   | Method | Path                    | Who   | Chain                                                       |
 *   |--------|-------------------------|-------|-------------------------------------------------------------|
 *   | GET    | /                       | any   | jwtAuth → zValidator(query) → handler                       |
 *   | GET    | /today                  | any   | jwtAuth → zValidator(query) → handler                       |
 *   | GET    | /subscriptions/me       | any   | jwtAuth → handler                                           |
 *   | GET    | /:id                    | any   | jwtAuth → zValidator(param) → handler                       |
 *   | POST   | /                       | admin | jwtAuth → requireRole → projectUserId → zValidator → idem   |
 *   | PATCH  | /:id                    | admin | jwtAuth → requireRole → projectUserId → zValidator ×2 → idem|
 *   | POST   | /:id/archive            | admin | jwtAuth → requireRole → projectUserId → zValidator → idem   |
 *   | POST   | /:id/subscription       | any   | jwtAuth → projectUserId → zValidator ×2 → idem              |
 *   | DELETE | /:id/subscription       | any   | jwtAuth → projectUserId → zValidator → idem                 |
 *
 * `GET /today?date=YYYY-MM-DD` is the mobile home contract: one entry
 * per active subscription with the workout prescribed on the member's
 * local date.
 *
 * Every read and write is scoped to the JWT claims (Req 13.2): the
 * adapter runs under `withTenant`, so RLS hides other studios' programs
 * and a cross-studio id surfaces as 404, never 403 (Req 13.5).
 *
 * Idempotency (Req 20.1): every mutation composes the idempotency
 * middleware with a store bound to the caller's tenant claims, so the
 * `idempotency_keys` owner policies apply under `athlya_app`.
 */

import {
  CreateProgramRequestSchema,
  ListProgramsQuerySchema,
  SubscribeProgramRequestSchema,
  TodayWorkoutQuerySchema,
  UpdateProgramRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
  idempotency,
  problem403,
  projectUserIdFromClaims,
  readValidated,
  requireRole,
  traceOperation,
} from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type {
  ArchiveProgramOutcome,
  CreateProgramOutcome,
  SubscribeProgramOutcome,
  UnsubscribeOutcome,
  UpdateProgramOutcome,
} from '@athlya/programs';
import type {
  CreateProgramRequest,
  ListProgramsQuery,
  ProgramDetail,
  ProgramSubscription,
  ProgramSummary,
  SubscribeProgramRequest,
  TodayWorkoutQuery,
  TodayWorkoutResponse,
  UpdateProgramRequest,
} from '@athlya/shared/schemas/api';
import type { Context, MiddlewareHandler } from 'hono';

const ProgramIdParamSchema = z.object({ id: z.uuid() }).strict();
type ProgramIdParam = z.infer<typeof ProgramIdParamSchema>;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/** Dependencies injected into {@link buildProgramsRouter}. */
export interface ProgramsDeps {
  listPrograms(
    claims: AuthClaims,
    query: ListProgramsQuery,
  ): Promise<{ readonly items: ReadonlyArray<ProgramSummary> }>;
  getProgram(claims: AuthClaims, programId: string): Promise<ProgramDetail | null>;
  createProgram(claims: AuthClaims, input: CreateProgramRequest): Promise<CreateProgramOutcome>;
  updateProgram(
    claims: AuthClaims,
    programId: string,
    input: UpdateProgramRequest,
  ): Promise<UpdateProgramOutcome>;
  archiveProgram(claims: AuthClaims, programId: string): Promise<ArchiveProgramOutcome>;
  subscribe(
    claims: AuthClaims,
    programId: string,
    input: SubscribeProgramRequest,
  ): Promise<SubscribeProgramOutcome>;
  unsubscribe(claims: AuthClaims, programId: string): Promise<UnsubscribeOutcome>;
  listMySubscriptions(
    claims: AuthClaims,
  ): Promise<{ readonly items: ReadonlyArray<ProgramSubscription> }>;
  getToday(
    claims: AuthClaims,
    date: string | undefined,
  ): Promise<TodayWorkoutResponse | { readonly kind: 'invalid_date' }>;
  /**
   * Idempotency store bound to the caller's tenant claims, or
   * `undefined` when the environment has none (the mutation then runs
   * without replay protection).
   */
  idempotencyFor?(claims: AuthClaims): IdempotencyMiddlewareDeps | undefined;
}

/* ------------------------------------------------------------------ */
/*  Problem Details                                                    */
/* ------------------------------------------------------------------ */

type ProblemStatus = 404 | 409 | 422;

const TITLES: Record<ProblemStatus, string> = {
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};

function problem(
  c: Context<HonoEnv>,
  status: ProblemStatus,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: TITLES[status],
      status,
      detail,
      code,
      traceId: c.get('traceId'),
      ...extra,
    }),
    status,
    { 'content-type': 'application/problem+json' },
  );
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

/** Build the `/v1/programs/*` sub-router. */
export function buildProgramsRouter(deps: ProgramsDeps): Hono<HonoEnv> {
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

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ GET / -------------------------- */
  router.get('/', zValidator('query', ListProgramsQuerySchema), async (c) => {
    traceOperation(c, 'programs.list');
    const query = readValidated<ListProgramsQuery>(c, 'query');
    const result = await deps.listPrograms(claimsOf(c), query);
    return c.json({ items: [...result.items] }, 200);
  });

  /* ------------------------------ GET /today --------------------- */
  router.get('/today', zValidator('query', TodayWorkoutQuerySchema), async (c) => {
    traceOperation(c, 'programs.today');
    const { date } = readValidated<TodayWorkoutQuery>(c, 'query');
    const result = await deps.getToday(claimsOf(c), date);
    if ('kind' in result) {
      return problem(c, 422, 'invalid_date', 'date must be within one year of today');
    }
    c.header('cache-control', 'private, no-store');
    return c.json(result, 200);
  });

  /* ------------------------------ GET /subscriptions/me ---------- */
  router.get('/subscriptions/me', async (c) => {
    traceOperation(c, 'programs.subscriptions.list-mine');
    const result = await deps.listMySubscriptions(claimsOf(c));
    return c.json({ items: [...result.items] }, 200);
  });

  /* ------------------------------ GET /:id ----------------------- */
  router.get('/:id', zValidator('param', ProgramIdParamSchema), async (c) => {
    traceOperation(c, 'programs.get');
    const { id } = readValidated<ProgramIdParam>(c, 'param');
    const program = await deps.getProgram(claimsOf(c), id);
    if (program === null) return problem(c, 404, 'not_found', `program ${id} not found`);
    return c.json(program, 200);
  });

  /* ------------------------------ POST / (admin) ----------------- */
  router.post(
    '/',
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('json', CreateProgramRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'programs.create');
      const body = readValidated<CreateProgramRequest>(c, 'json');
      const outcome = await deps.createProgram(claimsOf(c), body);
      if (outcome.kind === 'forbidden') return problem403(c, 'this endpoint requires admin');
      return c.json(outcome.program, 201);
    },
  );

  /* ------------------------------ PATCH /:id (admin) ------------- */
  router.patch(
    '/:id',
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('param', ProgramIdParamSchema),
    zValidator('json', UpdateProgramRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'programs.update');
      const { id } = readValidated<ProgramIdParam>(c, 'param');
      const body = readValidated<UpdateProgramRequest>(c, 'json');
      const outcome = await deps.updateProgram(claimsOf(c), id, body);
      switch (outcome.kind) {
        case 'updated':
          return c.json(outcome.program, 200);
        case 'conflict':
          return problem(
            c,
            409,
            'version_conflict',
            'program version mismatch — refetch and retry',
          );
        case 'archived':
          return problem(c, 409, 'program_archived', 'an archived program cannot be edited');
        case 'not_found':
          return problem(c, 404, 'not_found', `program ${id} not found`);
        case 'forbidden':
          return problem403(c, 'this endpoint requires admin');
      }
    },
  );

  /* ------------------------------ POST /:id/archive (admin) ------ */
  router.post(
    '/:id/archive',
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('param', ProgramIdParamSchema),
    idem,
    async (c) => {
      traceOperation(c, 'programs.archive');
      const { id } = readValidated<ProgramIdParam>(c, 'param');
      const outcome = await deps.archiveProgram(claimsOf(c), id);
      switch (outcome.kind) {
        case 'archived':
          return c.json(outcome.program, 200);
        case 'not_found':
          return problem(c, 404, 'not_found', `program ${id} not found`);
        case 'forbidden':
          return problem403(c, 'this endpoint requires admin');
      }
    },
  );

  /* ------------------------------ POST /:id/subscription --------- */
  router.post(
    '/:id/subscription',
    projectUserIdFromClaims(),
    zValidator('param', ProgramIdParamSchema),
    zValidator('json', SubscribeProgramRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'programs.subscribe');
      const { id } = readValidated<ProgramIdParam>(c, 'param');
      const body = readValidated<SubscribeProgramRequest>(c, 'json');
      const outcome = await deps.subscribe(claimsOf(c), id, body);
      switch (outcome.kind) {
        case 'subscribed':
          return c.json(outcome.subscription, 201);
        case 'already_subscribed':
          return problem(c, 409, 'already_subscribed', 'already subscribed to this program', {
            subscription: outcome.subscription,
          });
        case 'not_subscribable':
          return problem(
            c,
            409,
            'program_not_subscribable',
            'only a published program accepts subscriptions',
          );
        case 'invalid_start':
          return problem(
            c,
            422,
            'invalid_start',
            'startsOn must be between 28 days ago and 91 days ahead',
          );
        case 'not_found':
          return problem(c, 404, 'not_found', `program ${id} not found`);
      }
    },
  );

  /* ------------------------------ DELETE /:id/subscription ------- */
  router.delete(
    '/:id/subscription',
    projectUserIdFromClaims(),
    zValidator('param', ProgramIdParamSchema),
    idem,
    async (c) => {
      traceOperation(c, 'programs.unsubscribe');
      const { id } = readValidated<ProgramIdParam>(c, 'param');
      const outcome = await deps.unsubscribe(claimsOf(c), id);
      if (outcome.kind === 'not_found') {
        return problem(c, 404, 'not_found', `no active subscription to program ${id}`);
      }
      return c.body(null, 204);
    },
  );

  return router;
}
