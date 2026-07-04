/**
 * `/v1/members/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path              | Chain                                                              |
 *   |--------|-------------------|--------------------------------------------------------------------|
 *   | GET    | /me               | jwtAuth → handler                                                  |
 *   | PATCH  | /me               | jwtAuth → projectUserId → zValidator(body) → idempotency → handler |
 *   | PUT    | /me/avatar        | jwtAuth → handler (raw binary body)                                |
 *   | PATCH  | /me/consents      | jwtAuth → projectUserId → zValidator(body) → idempotency → handler |
 *   | POST   | /me/export        | jwtAuth → projectUserId → idempotency → handler (returns 202)      |
 *   | GET    | /                 | jwtAuth → requireRole('admin','coach') → zValidator(query) → handler |
 *
 * Requirements:
 *   • 3.1  — `GET /me` returns the authenticated member's profile.
 *   • 3.2, 3.4 — `PATCH /me` whitelists `displayName`, `avatarUrl`;
 *                display name length bounded to [1, 80] by the schema.
 *   • 3.2  — `PUT /me/avatar` uploads a new avatar to R2 and updates
 *            `users.avatarUrl` (N2.13). Mode dégradé when bucket absent.
 *   • 3.3  — `PATCH /me/consents` stamps `version` + `updatedAt`
 *            server-side and appends to the audit log (Req 22.1).
 *   • 3.5  — `GET /` is admin/coach-only and returns a cursor-paginated
 *            list scoped to the caller's studio.
 *   • 4.1  — `POST /me/export` returns 202 with a job id; the actual
 *            ZIP assembly is scheduled by QStash (Req 4.2).
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency per the
 *            shared middleware chain.
 */

import {
  UpdateConsentsRequestSchema,
  UpdateProfileRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_MAX_BYTES,
  AvatarInvalidFormatError,
  AvatarUploadNotConfiguredError,
} from '../adapters/avatar-upload-store-r2.js';
import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
  idempotency,
  problem403,
  projectUserIdFromClaims,
  readValidated,
  traceOperation,
  requireRole,
} from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { UpdateConsentsRequest, UpdateProfileRequest } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Local query schemas                                                */
/* ------------------------------------------------------------------ */

/**
 * Query shape accepted by `GET /v1/members`. Uses a small local
 * schema — shared schemas does not define one, and the admin listing
 * is the only consumer. Mirrors the conventions of
 * `@athlya/members/service`'s `listMembersByStudio` (default limit
 * 20, hard cap 100).
 */
const ListMembersQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

type ListMembersQuery = z.infer<typeof ListMembersQuerySchema>;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Framework-free `MembersPage` shape (mirrors the one returned by
 * `@athlya/members/service` `listMembersByStudio`). Declared here so
 * the router's public surface does not pull the members package into
 * its type graph at compile time — the gateway glue is free to pass
 * either shape.
 */
export interface MembersPageView {
  readonly items: ReadonlyArray<unknown>;
  readonly nextCursor: string | null;
}

/** Opaque profile view. The gateway forwards whatever the service returns. */
export type MemberProfileView = unknown;

/**
 * Dependencies injected into {@link buildMembersRouter}. Each method
 * mirrors a use case from `@athlya/members` but stays loosely typed
 * so this module never imports from the members package directly.
 */
export interface MembersDeps {
  getProfile(userId: string, claims: AuthClaims): Promise<MemberProfileView>;
  updateProfile(
    userId: string,
    patch: UpdateProfileRequest,
    claims: AuthClaims,
  ): Promise<MemberProfileView>;
  /**
   * Upload a raw image body to R2 and persist the resulting public URL
   * on the user's profile in one shot (N2.13).
   *
   * @throws {AvatarUploadNotConfiguredError} when the bucket or public
   *   URL binding is not provisioned — the route handler maps this to 503.
   */
  uploadAvatar(
    userId: string,
    contentType: string,
    body: ArrayBuffer,
    claims: AuthClaims,
  ): Promise<{ avatarUrl: string }>;
  updateConsents(
    userId: string,
    input: UpdateConsentsRequest,
    claims: AuthClaims,
  ): Promise<unknown>;
  enqueueExport(userId: string, claims: AuthClaims): Promise<{ jobId: string }>;
  listMembersByStudio(
    studioId: string,
    requesterRole: 'admin' | 'coach',
    opts: ListMembersQuery,
    claims: AuthClaims,
  ): Promise<MembersPageView>;

  /** Dependency bundle forwarded to the idempotency middleware. */
  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers (avatar upload)                            */
/* ------------------------------------------------------------------ */

const PROBLEM_JSON = 'application/problem+json';

function avatarProblem(
  c: Context<HonoEnv>,
  status: 400 | 411 | 413 | 415 | 422 | 503,
  detail: string,
  code: string,
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title:
        status === 503
          ? 'Service Unavailable'
          : status === 422
            ? 'Unprocessable Content'
            : status === 415
              ? 'Unsupported Media Type'
              : status === 413
                ? 'Content Too Large'
                : status === 411
                  ? 'Length Required'
                  : 'Bad Request',
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status,
    { 'content-type': PROBLEM_JSON },
  );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/members/*` sub-router. */
export function buildMembersRouter(deps: MembersDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  // Every /v1/members route requires authentication. Mount once at
  // the router root so each handler does not repeat the chain.
  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ GET /me ------------------------ */
  router.get('/me', async (c) => {
    traceOperation(c, 'members.get-mine');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const profile = await deps.getProfile(claims.userId, claims);
    return c.json(profile as Record<string, unknown>, 200);
  });

  /* ------------------------------ PATCH /me ---------------------- */
  router.patch(
    '/me',
    projectUserIdFromClaims(),
    zValidator('json', UpdateProfileRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'members.update-mine');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const patch = readValidated<UpdateProfileRequest>(c, 'json');
      const updated = await deps.updateProfile(claims.userId, patch, claims);
      return c.json(updated as Record<string, unknown>, 200);
    },
  );

  /* ------------------------------ PUT /me/avatar ----------------- */
  // Raw binary upload — no JSON body, no Zod validator, no idempotency.
  // Content-Type header IS the format discriminator. The raw body is
  // read via `c.req.raw.arrayBuffer()` to preserve byte integrity for
  // the R2 `put` call.
  router.put('/me/avatar', async (c) => {
    traceOperation(c, 'members.upload-avatar');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }

    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!AVATAR_ALLOWED_TYPES.has(contentType)) {
      return avatarProblem(
        c,
        415,
        'Content-Type must be image/jpeg, image/png, or image/webp',
        'unsupported_media_type',
      );
    }

    const rawContentLength = c.req.header('content-length');
    if (rawContentLength === undefined || rawContentLength === null) {
      return avatarProblem(
        c,
        411,
        'Content-Length is required for avatar uploads',
        'length_required',
      );
    }
    const contentLength = parseInt(rawContentLength, 10);
    if (isNaN(contentLength) || contentLength < 0) {
      return avatarProblem(
        c,
        400,
        'Content-Length must be a non-negative integer',
        'invalid_content_length',
      );
    }
    if (contentLength > AVATAR_MAX_BYTES) {
      return avatarProblem(
        c,
        413,
        `Avatar must not exceed ${AVATAR_MAX_BYTES / (1024 * 1024)} MB`,
        'avatar_too_large',
      );
    }

    const body = await c.req.raw.arrayBuffer();
    if (body.byteLength > AVATAR_MAX_BYTES) {
      return avatarProblem(
        c,
        413,
        `Avatar must not exceed ${AVATAR_MAX_BYTES / (1024 * 1024)} MB`,
        'avatar_too_large',
      );
    }
    if (body.byteLength === 0) {
      return avatarProblem(c, 400, 'Body must not be empty', 'empty_body');
    }

    try {
      const result = await deps.uploadAvatar(claims.userId, contentType, body, claims);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof AvatarInvalidFormatError) {
        return avatarProblem(
          c,
          422,
          'File content does not match declared content type',
          'avatar_invalid_format',
        );
      }
      if (err instanceof AvatarUploadNotConfiguredError) {
        return avatarProblem(
          c,
          503,
          'Avatar storage is not configured for this environment',
          'avatar_upload_not_configured',
        );
      }
      throw err;
    }
  });

  /* ------------------------------ PATCH /me/consents ------------- */
  router.patch(
    '/me/consents',
    projectUserIdFromClaims(),
    zValidator('json', UpdateConsentsRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'members.update-consents');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const patch = readValidated<UpdateConsentsRequest>(c, 'json');
      const consents = await deps.updateConsents(claims.userId, patch, claims);
      return c.json(consents as Record<string, unknown>, 200);
    },
  );

  /* ------------------------------ POST /me/export ---------------- */
  router.post(
    '/me/export',
    projectUserIdFromClaims(),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'members.export-mine');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const { jobId } = await deps.enqueueExport(claims.userId, claims);
      // 202 Accepted — ZIP assembly runs out-of-band (Req 4.2).
      return c.json({ jobId }, 202);
    },
  );

  /* ------------------------------ GET / (admin / coach) ---------- */
  router.get(
    '/',
    requireRole('admin', 'coach'),
    zValidator('query', ListMembersQuerySchema),
    async (c) => {
      traceOperation(c, 'members.list-by-studio');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      if (claims.role !== 'admin' && claims.role !== 'coach') {
        // requireRole already returned 403; this is defense in
        // depth in case the middleware is rearranged.
        return problem403(c, 'listing studio members requires admin or coach role');
      }
      const query = readValidated<ListMembersQuery>(c, 'query');
      const page = await deps.listMembersByStudio(claims.studioId, claims.role, query, claims);
      return c.json(page as unknown as Record<string, unknown>, 200);
    },
  );

  return router;
}
