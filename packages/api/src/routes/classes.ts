/**
 * `/v1/classes/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path  | Chain                                                                    |
 *   |--------|-------|--------------------------------------------------------------------------|
 *   | GET    | /     | jwtAuth → zValidator(query: ListClassesQuerySchema) → handler            |
 *   | POST   | /     | jwtAuth → requireRole('admin') → projectUserId → zValidator(body) → idempotency → handler |
 *   | PATCH  | /:id  | jwtAuth → requireRole('admin') → projectUserId → zValidator(param + body) → idempotency → handler |
 *
 * Requirements:
 *   • 7.1, 7.3 — range-bounded listing via `ListClassesQuerySchema`
 *                (rejects `range_inverted` / `range_too_large`).
 *   • 6.1–6.4 — `POST /` validates capacity / duration / startsAt via
 *                `CreateClassRequestSchema`.
 *   • 6.5–6.7 — admin-only editing with `expectedVersion` in the
 *                body (Req 6.6). The optimistic-lock conflict surfaces
 *                as `reservations.updateClass` returning `null`,
 *                which this router renders as HTTP 409 Conflict.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency per the
 *                shared middleware chain.
 */

import {
  CreateClassRequestSchema,
  ListClassesQuerySchema,
  SearchClassesQuerySchema,
  UpdateClassRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
  computeListEtag,
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  requireRole,
  traceOperation,
} from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type {
  CreateClassRequest,
  ListClassesQuery,
  SearchClassesQuery,
  UpdateClassRequest,
} from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Local path-param schema                                            */
/* ------------------------------------------------------------------ */

const ClassIdParamSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

type ClassIdParam = z.infer<typeof ClassIdParamSchema>;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Discriminated result returned by {@link ClassesDeps.updateClass}.
 * Mirrors the pattern the domain service uses: `null` becomes a 409
 * Conflict at the wire.
 */
export type UpdateClassOutcome =
  | { readonly kind: 'updated'; readonly class: unknown }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'capacity_below_confirmed' }
  | { readonly kind: 'class_already_started' }
  | { readonly kind: 'starts_at_in_past' }
  | { readonly kind: 'not_found' };

/**
 * Discriminated result returned by {@link ClassesDeps.deleteClass}.
 */
export type DeleteClassOutcome = { readonly kind: 'deleted' } | { readonly kind: 'not_found' };

/** Dependencies injected into {@link buildClassesRouter}. */
export interface ClassesDeps {
  listClasses(
    studioId: string,
    range: ListClassesQuery,
    claims: AuthClaims,
  ): Promise<{ items: ReadonlyArray<unknown> }>;
  searchClasses(
    studioId: string,
    query: SearchClassesQuery,
    claims: AuthClaims,
  ): Promise<{ items: ReadonlyArray<unknown> }>;
  createClass(studioId: string, input: CreateClassRequest, claims: AuthClaims): Promise<unknown>;
  updateClass(
    studioId: string,
    classId: string,
    patch: UpdateClassRequest,
    claims: AuthClaims,
  ): Promise<UpdateClassOutcome>;
  deleteClass(studioId: string, classId: string, claims: AuthClaims): Promise<DeleteClassOutcome>;

  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details 409 helper                                         */
/* ------------------------------------------------------------------ */

/**
 * Problem Details body emitted when the optimistic-lock `version`
 * guard fails (Req 6.6). `code` matches the `conflict` slug the
 * mobile drain loop expects (design §E2).
 */
function problem409(
  c: Context<HonoEnv>,
  detail: string,
  code:
    'version_conflict' | 'capacity_below_confirmed' | 'class_already_started' = 'version_conflict',
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    409,
    { 'content-type': 'application/problem+json' },
  );
}

/** Problem Details body for a class start time that is not in the future. */
function problem422StartsAtInPast(c: Context<HonoEnv>): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'a class cannot be moved to a start time that is not in the future',
      code: 'starts_at_in_past',
      traceId: c.get('traceId'),
    }),
    422,
    { 'content-type': 'application/problem+json' },
  );
}

/**
 * Problem Details body emitted when the class id does not resolve to
 * a row under the tenant (post-RLS).
 */
function problem404(c: Context<HonoEnv>, detail: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail,
      code: 'not_found',
      traceId: c.get('traceId'),
    }),
    404,
    { 'content-type': 'application/problem+json' },
  );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/classes/*` sub-router. */
export function buildClassesRouter(deps: ClassesDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  // Every /v1/classes route is authenticated.
  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ GET /search -------------------- */
  router.get('/search', zValidator('query', SearchClassesQuerySchema), async (c) => {
    traceOperation(c, 'classes.search');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const query = readValidated<SearchClassesQuery>(c, 'query');
    const result = await deps.searchClasses(claims.studioId, query, claims);
    return c.json({ items: result.items as unknown[] }, 200);
  });

  /* ------------------------------ GET / -------------------------- */
  router.get('/', zValidator('query', ListClassesQuerySchema), async (c) => {
    traceOperation(c, 'classes.list');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const query = readValidated<ListClassesQuery>(c, 'query');
    const result = await deps.listClasses(claims.studioId, query, claims);

    // B5.1 — ETag + Cache-Control. The listing is tenant-scoped,
    // range-bounded and counter-driven; data turns over either
    // when an admin creates a class or when a reservation
    // mutates the Redis-backed `remaining`. A 10-second
    // private cache is safe (the UI tolerates a brief stale
    // counter) and the `vary: authorization` header keeps
    // intermediaries from sharing the response across users.
    //
    // The fingerprint covers the fields a refetch needs to see
    // change: `id`, `version` (admin-edits the title /
    // capacity / startsAt), `remaining` (live counter) and
    // `startsAt` (in case the admin reschedules but the row
    // stays under the same id). Order matters because
    // `findInRange` already returns rows sorted ASC.
    const items = [...result.items] as ReadonlyArray<{
      id?: string | number | null;
      version?: number | null;
      remaining?: number | null;
      startsAt?: string | null;
    }>;
    const fingerprint = items
      .map((item) => {
        const id = String(item.id ?? '');
        const version = String(item.version ?? 0);
        const remaining = String(item.remaining ?? 0);
        const startsAt = String(item.startsAt ?? '');
        return `${id}:${version}:${remaining}:${startsAt}`;
      })
      .join('|');
    const etag = await computeListEtag(fingerprint);

    const ifNoneMatch = c.req.header('if-none-match');
    // Strict comparison per RFC 7232 §2.3.2 — we only emit
    // strong ETags so weak comparators do not need to be
    // handled. The header may carry the value with or
    // without the surrounding quotes depending on the
    // proxy that touched it; normalise both sides.
    const normalisedIncoming =
      ifNoneMatch !== undefined ? ifNoneMatch.trim().replace(/^W\//, '') : undefined;
    if (normalisedIncoming === etag) {
      c.header('etag', etag);
      c.header('cache-control', 'private, max-age=10, must-revalidate');
      c.header('vary', 'authorization');
      return c.body(null, 304);
    }

    c.header('etag', etag);
    c.header('cache-control', 'private, max-age=10, must-revalidate');
    c.header('vary', 'authorization');
    return c.json({ items: items as unknown[] }, 200);
  });

  /* ------------------------------ POST / (admin) ----------------- */
  router.post(
    '/',
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('json', CreateClassRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'classes.create');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<CreateClassRequest>(c, 'json');
      const created = await deps.createClass(claims.studioId, body, claims);
      return c.json(created as Record<string, unknown>, 201);
    },
  );

  /* ------------------------------ PATCH /:id (admin) ------------- */
  router.patch(
    '/:id',
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('param', ClassIdParamSchema),
    zValidator('json', UpdateClassRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'classes.update');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const { id } = readValidated<ClassIdParam>(c, 'param');
      const patch = readValidated<UpdateClassRequest>(c, 'json');
      const outcome = await deps.updateClass(claims.studioId, id, patch, claims);
      switch (outcome.kind) {
        case 'updated':
          return c.json(outcome.class as Record<string, unknown>, 200);
        case 'conflict':
          return problem409(c, 'class version mismatch — refetch and retry');
        case 'capacity_below_confirmed':
          return problem409(
            c,
            'capacity cannot be lowered below the number of confirmed reservations and held seats',
            'capacity_below_confirmed',
          );
        case 'class_already_started':
          return problem409(
            c,
            'the class already started; its start time cannot change',
            'class_already_started',
          );
        case 'starts_at_in_past':
          return problem422StartsAtInPast(c);
        case 'not_found':
          return problem404(c, `class ${id} not found`);
      }
    },
  );

  /* ------------------------------ DELETE /:id (admin) ----------- */
  router.delete(
    '/:id',
    requireRole('admin'),
    zValidator('param', ClassIdParamSchema),
    async (c) => {
      traceOperation(c, 'classes.delete');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const { id } = readValidated<ClassIdParam>(c, 'param');
      const outcome = await deps.deleteClass(claims.studioId, id, claims);
      if (outcome.kind === 'not_found') {
        return problem404(c, `class ${id} not found`);
      }
      return c.body(null, 204);
    },
  );

  return router;
}
