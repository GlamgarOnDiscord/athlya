/**
 * `/v1/reservations/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path  | Chain                                                                 |
 *   |--------|-------|-----------------------------------------------------------------------|
 *   | POST   | /     | jwtAuth → projectUserId → zValidator(BookingRequestSchema) → idempotency → handler |
 *   | DELETE | /:id  | jwtAuth → projectUserId → zValidator(CancelReservationParamsSchema) → idempotency → handler |
 *   | GET    | /me   | jwtAuth → zValidator(query) → handler                                |
 *
 * Requirements:
 *   • 8.1, 8.2 — `POST /` returns 201 Created for a confirmed seat
 *                or 202 Accepted for a waitlisted one.
 *   • 8.4, 8.5 — idempotent booking via `Idempotency-Key` header +
 *                `UNIQUE(class_id, user_id)` DB constraint.
 *   • 9.1, 9.2 — `DELETE /:id` respects the 2-hour cancellation
 *                window (`cancellation_window_closed` on violation).
 *   • 9.3      — waitlist FIFO promotion runs in the same
 *                transaction as the cancellation.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 */

import { BookingRequestSchema, CancelReservationParamsSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import { notifyCapacityChange } from '../durable-objects/notify.js';
import { jwtAuth } from '../middleware/auth.js';
import { concurrencyLimit } from '../middleware/concurrency-limit.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
  computeListEtag,
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  traceOperation,
} from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { BookingRequest, CancelReservationParams } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Local schemas                                                      */
/* ------------------------------------------------------------------ */

/**
 * Query shape accepted by `GET /v1/reservations/me`. Both bounds are
 * optional — the repo defaults to the last 90 days when neither is
 * supplied.
 */
const ListMyReservationsQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

type ListMyReservationsQuery = z.infer<typeof ListMyReservationsQuerySchema>;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Discriminated outcome returned by {@link ReservationsDeps.bookClass}.
 * Mirrors the shape used by `@athlya/reservations/book` — `waitlist`
 * carries the 1-based FIFO position.
 *
 *   • `confirmed` → HTTP 201 with the reservation body.
 *   • `waitlist`  → HTTP 202 with the reservation + `position`.
 *   • `conflict`  → HTTP 409 (already-booked idempotent replay,
 *                   design §E2).
 *   • `class_in_past` → HTTP 422.
 */
export type BookingOutcome =
  | { readonly kind: 'confirmed'; readonly reservation: unknown }
  | {
      readonly kind: 'waitlist';
      readonly reservation: unknown;
      readonly position: number;
    }
  | { readonly kind: 'conflict'; readonly reservation: unknown }
  | { readonly kind: 'class_in_past' }
  | { readonly kind: 'not_found' };

/** Outcome for `cancelReservation`. Mirrors design §6.11. */
export type CancelOutcome =
  | { readonly kind: 'cancelled'; readonly reservation: unknown }
  | { readonly kind: 'promoted'; readonly reservation: unknown }
  | { readonly kind: 'window_closed' }
  | { readonly kind: 'invalid_transition' }
  | { readonly kind: 'not_found' };

export interface ReservationsDeps {
  bookClass(userId: string, input: BookingRequest): Promise<BookingOutcome>;
  cancelReservation(userId: string, params: CancelReservationParams): Promise<CancelOutcome>;
  listMyReservations(
    userId: string,
    query: ListMyReservationsQuery,
  ): Promise<{ items: ReadonlyArray<unknown> }>;
  getRemainingSeats(classId: string): Promise<number | null>;

  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

function problemBody(
  c: Context<HonoEnv>,
  status: number,
  title: string,
  code: string,
  detail: string,
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title,
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status as 409 | 422 | 404,
    { 'content-type': 'application/problem+json' },
  );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/reservations/*` sub-router. */
export function buildReservationsRouter(deps: ReservationsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  // Every /v1/reservations route is authenticated.
  router.use('*', jwtAuth());

  // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
  // Mounted AFTER `jwtAuth()` so `authClaims.studioId` is set.
  // Self-skips in dev. Default budget 1000 req/60s/studio.
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  // Sprint 12 / Slice 12.14 (Epic B4.3) — per-user concurrency
  // cap. Mounted AFTER `jwtAuth()` so `authClaims.userId` is set.
  // The middleware self-skips in dev (`ENVIRONMENT === 'dev'`)
  // so integration tests pointing at `test.upstash.invalid`
  // do not hang. Production / staging enforce the 10-in-flight
  // cap per user.
  router.use('*', concurrencyLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ POST / ------------------------- */
  router.post(
    '/',
    projectUserIdFromClaims(),
    zValidator('json', BookingRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'reservations.book');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<BookingRequest>(c, 'json');
      const outcome = await deps.bookClass(claims.userId, body);

      if (outcome.kind === 'confirmed' || outcome.kind === 'waitlist') {
        try {
          c.executionCtx?.waitUntil(
            (async () => {
              try {
                const remaining = await deps.getRemainingSeats(body.classId);
                if (remaining !== null) {
                  await notifyCapacityChange(c.env, body.classId, remaining);
                }
              } catch {
                // Best-effort capacity notification.
              }
            })(),
          );
        } catch {
          // No ExecutionContext in non-Cloudflare environments.
        }
      }

      switch (outcome.kind) {
        case 'confirmed':
          return c.json(
            {
              status: 'confirmed',
              reservation: outcome.reservation,
            },
            201,
          );
        case 'waitlist':
          return c.json(
            {
              status: 'waitlist',
              reservation: outcome.reservation,
              position: outcome.position,
            },
            202,
          );
        case 'conflict':
          return c.json(
            {
              status: 'confirmed',
              reservation: outcome.reservation,
            },
            409,
          );
        case 'class_in_past':
          return problemBody(
            c,
            422,
            'Unprocessable Entity',
            'class_in_past',
            'class has already started',
          );
        case 'not_found':
          return problemBody(c, 404, 'Not Found', 'not_found', 'class not found');
      }
    },
  );

  /* ------------------------------ DELETE /:reservationId --------- */
  // The path param name MUST match the `CancelReservationParamsSchema`
  // key (`reservationId`) exactly — Hono's `c.req.param()` returns a
  // flat `Record<string, string>` keyed by the path variable name,
  // and `zValidator('param', …).strict()` rejects a payload whose
  // keys don't match. An earlier draft of this router used `:id`
  // which tripped every cancel request into a 422 before reaching
  // `deps.cancelReservation`; task 8.12's integration tests caught
  // the mismatch.
  router.delete(
    '/:reservationId',
    projectUserIdFromClaims(),
    zValidator('param', CancelReservationParamsSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'reservations.cancel');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const params = readValidated<CancelReservationParams>(c, 'param');
      const outcome = await deps.cancelReservation(claims.userId, params);

      if (outcome.kind === 'cancelled' || outcome.kind === 'promoted') {
        const classId = (outcome.reservation as Record<string, unknown>)['classId'];
        if (typeof classId === 'string') {
          try {
            c.executionCtx?.waitUntil(
              (async () => {
                try {
                  const remaining = await deps.getRemainingSeats(classId);
                  if (remaining !== null) await notifyCapacityChange(c.env, classId, remaining);
                } catch {
                  // Best-effort capacity notification.
                }
              })(),
            );
          } catch {
            // No ExecutionContext in non-Cloudflare environments.
          }
        }
      }

      switch (outcome.kind) {
        case 'cancelled':
        case 'promoted':
          return c.json(
            {
              status: 'cancelled',
              reservation: outcome.reservation,
            },
            200,
          );
        case 'window_closed':
          return problemBody(
            c,
            422,
            'Unprocessable Entity',
            'cancellation_window_closed',
            'cancellation window closed (< 2h before class starts)',
          );
        case 'invalid_transition':
          return problemBody(
            c,
            422,
            'Unprocessable Entity',
            'invalid_transition',
            'reservation cannot transition from its current state',
          );
        case 'not_found':
          return problemBody(c, 404, 'Not Found', 'not_found', 'reservation not found');
      }
    },
  );

  /* ------------------------------ GET /me ------------------------ */
  router.get('/me', zValidator('query', ListMyReservationsQuerySchema), async (c) => {
    traceOperation(c, 'reservations.list-mine');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const query = readValidated<ListMyReservationsQuery>(c, 'query');
    const result = await deps.listMyReservations(claims.userId, query);

    // B5.2 — ETag + Cache-Control. Reservation status mutates
    // in real time when the owner cancels or when the
    // waitlist promotion job runs, so the safe stale window
    // is shorter than for the public class listing (5 s vs.
    // 10 s in B5.1).
    //
    // The fingerprint covers the state-tracking fields a
    // refetch needs to see change: `id`, `status` (the live
    // state), `cancelledAt` and `checkedInAt` (the two
    // timestamps the state machine stamps on transitions).
    // `updatedAt` is not part of the projection — the two
    // timestamps cover every transition the wire surface
    // exposes.
    const items = [...result.items] as ReadonlyArray<{
      id?: string | number | null;
      status?: string | null;
      cancelledAt?: string | null;
      checkedInAt?: string | null;
    }>;
    const fingerprint = items
      .map((item) => {
        const id = String(item.id ?? '');
        const status = String(item.status ?? '');
        const cancelledAt = String(item.cancelledAt ?? '');
        const checkedInAt = String(item.checkedInAt ?? '');
        return `${id}:${status}:${cancelledAt}:${checkedInAt}`;
      })
      .join('|');
    const etag = await computeListEtag(fingerprint);

    const ifNoneMatch = c.req.header('if-none-match');
    const normalisedIncoming =
      ifNoneMatch !== undefined ? ifNoneMatch.trim().replace(/^W\//, '') : undefined;
    if (normalisedIncoming === etag) {
      c.header('etag', etag);
      c.header('cache-control', 'private, max-age=5, must-revalidate');
      c.header('vary', 'authorization');
      return c.body(null, 304);
    }

    c.header('etag', etag);
    c.header('cache-control', 'private, max-age=5, must-revalidate');
    c.header('vary', 'authorization');
    return c.json({ items: items as unknown[] }, 200);
  });

  return router;
}
