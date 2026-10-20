/**
 * `/v1/reservations/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path         | Chain                                                                 |
 *   |--------|--------------|-----------------------------------------------------------------------|
 *   | POST   | /            | jwtAuth → projectUserId → zValidator(BookingRequestSchema) → idempotency → handler |
 *   | POST   | /holds       | jwtAuth → projectUserId → zValidator(HoldRequestSchema) → idempotency → handler |
 *   | POST   | /:id/confirm | jwtAuth → projectUserId → zValidator(ConfirmHoldParamsSchema) → idempotency → handler |
 *   | DELETE | /:id         | jwtAuth → projectUserId → zValidator(CancelReservationParamsSchema) → idempotency → handler |
 *   | GET    | /me          | jwtAuth → zValidator(query) → handler                                |
 *
 * Requirements:
 *   • 8.1, 8.2 — `POST /` returns 201 Created for a confirmed seat
 *                or 202 Accepted for a waitlisted one.
 *   • 8.4, 8.5 — idempotent booking via `Idempotency-Key` header +
 *                the partial `UNIQUE(class_id, user_id)` index. Both
 *                mutations run the idempotency middleware in strict
 *                mode (in-flight marker, request hash, fail closed),
 *                resolved per request from the caller's claims.
 *   • A retried `DELETE` of a reservation that is already cancelled
 *                answers 200 with the stored row and
 *                `alreadyCancelled: true`, never a 422.
 *   • 9.1, 9.2 — `DELETE /:id` respects the 2-hour cancellation
 *                window (`cancellation_window_closed` on violation).
 *   • 9.3      — waitlist FIFO promotion runs in the same
 *                transaction as the cancellation.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 *   • Issue #723: seat holds: `POST /holds` keeps a seat for a bounded
 *                time, `POST /:id/confirm` books it, `DELETE /:id`
 *                releases it. `classVersion` in a booking or hold body
 *                fences on the class version (409 `class_changed`).
 */

import {
  BookingRequestSchema,
  CancelReservationParamsSchema,
  ConfirmHoldParamsSchema,
  HoldRequestSchema,
} from '@athlya/shared/schemas/api';
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

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type {
  BookingRequest,
  CancelReservationParams,
  ConfirmHoldParams,
  HoldRequest,
} from '@athlya/shared/schemas/api';
import type { Context, MiddlewareHandler } from 'hono';

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
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    cursor: z.string().min(1).optional(),
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
 *   • `confirmed`           → HTTP 201 with the reservation body.
 *   • `waitlist`            → HTTP 202 with the reservation + `position`.
 *   • `conflict`            → HTTP 409 (already-booked idempotent replay),
 *                             with the existing row's real status and,
 *                             for a waitlist row, its position.
 *   • `class_in_past`       → HTTP 422.
 *   • `class_changed`       → HTTP 409 (the `classVersion` sent is stale).
 *   • `counter_unavailable` → HTTP 503 (Redis down; client should retry).
 */
export type BookingOutcome =
  | { readonly kind: 'confirmed'; readonly reservation: unknown }
  | {
      readonly kind: 'waitlist';
      readonly reservation: unknown;
      readonly position: number;
    }
  | {
      readonly kind: 'conflict';
      readonly status: 'confirmed' | 'waitlist';
      readonly reservation: unknown;
      readonly position?: number;
    }
  | { readonly kind: 'class_in_past' }
  | { readonly kind: 'class_changed' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'counter_unavailable' };

/** A seat hold as answered on the wire. */
export interface HoldView {
  readonly reservationId: string;
  readonly classId: string;
  readonly expiresAt: Date;
}

/**
 * Outcome for `placeHold` (issue #723):
 *
 *   • `held`         → HTTP 201 with the hold.
 *   • `already_held` → HTTP 200 with the member's active hold (a retry).
 *   • `conflict`     → HTTP 409, the member already has a confirmed or
 *                      waitlist row, as for a booking replay.
 *   • `class_full`   → HTTP 409 Problem `class_full` (nothing held).
 *   • the other kinds as for a booking.
 */
export type HoldOutcome =
  | { readonly kind: 'held'; readonly hold: HoldView }
  | { readonly kind: 'already_held'; readonly hold: HoldView }
  | {
      readonly kind: 'conflict';
      readonly status: 'confirmed' | 'waitlist';
      readonly reservation: unknown;
      readonly position?: number;
    }
  | { readonly kind: 'class_full' }
  | { readonly kind: 'class_in_past' }
  | { readonly kind: 'class_changed' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'counter_unavailable' };

/**
 * Outcome for `confirmHold`: `confirmed` → 201, `already_confirmed` →
 * 200 (a retry), `hold_expired` / `not_a_hold` → 409, `not_found` → 404.
 */
export type ConfirmHoldOutcome =
  | { readonly kind: 'confirmed'; readonly reservation: unknown }
  | { readonly kind: 'already_confirmed'; readonly reservation: unknown }
  | { readonly kind: 'hold_expired' }
  | { readonly kind: 'not_a_hold' }
  | { readonly kind: 'not_found' };

/** Outcome for `cancelReservation`. Mirrors design §6.11. */
export type CancelOutcome =
  | { readonly kind: 'cancelled'; readonly reservation: unknown }
  | { readonly kind: 'promoted'; readonly reservation: unknown }
  | { readonly kind: 'already_cancelled'; readonly reservation: unknown }
  | { readonly kind: 'window_closed' }
  | { readonly kind: 'invalid_transition' }
  | { readonly kind: 'not_found' };

export interface ReservationsDeps {
  bookClass(claims: AuthClaims, input: BookingRequest): Promise<BookingOutcome>;
  cancelReservation(claims: AuthClaims, params: CancelReservationParams): Promise<CancelOutcome>;
  placeHold(claims: AuthClaims, input: HoldRequest): Promise<HoldOutcome>;
  confirmHold(claims: AuthClaims, params: ConfirmHoldParams): Promise<ConfirmHoldOutcome>;
  listMyReservations(
    userId: string,
    query: ListMyReservationsQuery,
    claims: AuthClaims,
  ): Promise<{ items: ReadonlyArray<unknown>; nextCursor: string | null }>;
  getRemainingSeats(classId: string): Promise<number | null>;

  /**
   * Idempotency store bound to the caller's tenant claims. `undefined`
   * (dev stub) runs the route without replay protection.
   */
  idempotencyFor?(claims: AuthClaims): IdempotencyMiddlewareDeps | undefined;
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

function counterUnavailable(c: Context<HonoEnv>): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'counter_unavailable',
      detail: 'Seat counter temporarily unavailable — retry in a moment',
      traceId: c.get('traceId'),
    }),
    503,
    { 'content-type': 'application/problem+json', 'retry-after': '5' },
  );
}

function classChanged(c: Context<HonoEnv>): Response {
  return problemBody(
    c,
    409,
    'Conflict',
    'class_changed',
    'the class changed since it was read; refetch it and retry',
  );
}

function holdBody(hold: HoldView): { status: 'held'; hold: Record<string, string> } {
  return {
    status: 'held',
    hold: {
      reservationId: hold.reservationId,
      classId: hold.classId,
      expiresAt: hold.expiresAt.toISOString(),
    },
  };
}

/** Push the new remaining-seat count to live listeners, best effort. */
function notifyRemaining(c: Context<HonoEnv>, deps: ReservationsDeps, classId: string): void {
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

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/reservations/*` sub-router. */
export function buildReservationsRouter(deps: ReservationsDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  /** Idempotency bound per request to the caller's tenant claims. */
  const idem: MiddlewareHandler<HonoEnv> = async (c, next) => {
    const claims = c.get('authClaims');
    const store = claims === undefined ? undefined : deps.idempotencyFor?.(claims);
    if (store === undefined) {
      await next();
      return;
    }
    return idempotency(store)(c, next);
  };

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
    idem,
    async (c) => {
      traceOperation(c, 'reservations.book');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<BookingRequest>(c, 'json');
      const outcome = await deps.bookClass(claims, body);

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
              status: outcome.status,
              reservation: outcome.reservation,
              ...(outcome.position !== undefined ? { position: outcome.position } : {}),
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
        case 'class_changed':
          return classChanged(c);
        case 'not_found':
          return problemBody(c, 404, 'Not Found', 'not_found', 'class not found');
        case 'counter_unavailable':
          return counterUnavailable(c);
      }
    },
  );

  /* ------------------------------ POST /holds -------------------- */
  router.post(
    '/holds',
    projectUserIdFromClaims(),
    zValidator('json', HoldRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'reservations.hold');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<HoldRequest>(c, 'json');
      const outcome = await deps.placeHold(claims, body);

      switch (outcome.kind) {
        case 'held':
          notifyRemaining(c, deps, body.classId);
          return c.json(holdBody(outcome.hold), 201);
        case 'already_held':
          return c.json(holdBody(outcome.hold), 200);
        case 'conflict':
          return c.json(
            {
              status: outcome.status,
              reservation: outcome.reservation,
              ...(outcome.position !== undefined ? { position: outcome.position } : {}),
            },
            409,
          );
        case 'class_full':
          return problemBody(
            c,
            409,
            'Conflict',
            'class_full',
            'no seat left to hold; book to join the waitlist',
          );
        case 'class_changed':
          return classChanged(c);
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
        case 'counter_unavailable':
          return counterUnavailable(c);
      }
    },
  );

  /* ------------------------------ POST /:reservationId/confirm --- */
  router.post(
    '/:reservationId/confirm',
    projectUserIdFromClaims(),
    zValidator('param', ConfirmHoldParamsSchema),
    idem,
    async (c) => {
      traceOperation(c, 'reservations.confirm-hold');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const params = readValidated<ConfirmHoldParams>(c, 'param');
      const outcome = await deps.confirmHold(claims, params);

      switch (outcome.kind) {
        case 'confirmed':
          return c.json({ status: 'confirmed', reservation: outcome.reservation }, 201);
        case 'already_confirmed':
          return c.json({ status: 'confirmed', reservation: outcome.reservation }, 200);
        case 'hold_expired':
          return problemBody(
            c,
            409,
            'Conflict',
            'hold_expired',
            'the hold expired or was released; place a new hold or book',
          );
        case 'not_a_hold':
          return problemBody(
            c,
            409,
            'Conflict',
            'not_a_hold',
            'this reservation is not a seat hold',
          );
        case 'not_found':
          return problemBody(c, 404, 'Not Found', 'not_found', 'reservation not found');
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
    idem,
    async (c) => {
      traceOperation(c, 'reservations.cancel');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const params = readValidated<CancelReservationParams>(c, 'param');
      const outcome = await deps.cancelReservation(claims, params);

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
        case 'already_cancelled':
          return c.json(
            {
              status: 'cancelled',
              reservation: outcome.reservation,
              alreadyCancelled: true,
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
    const result = await deps.listMyReservations(claims.userId, query, claims);

    // B5.2 — ETag + Cache-Control. Reservation status mutates
    // in real time when the owner cancels or when the
    // waitlist promotion job runs, so the safe stale window
    // is shorter than for the public class listing (5 s vs.
    // 10 s in B5.1).
    //
    // Issue #314 — class fields (startsAt, title, durationMin) are
    // included so ETag changes when an admin updates a class, forcing
    // clients to refetch instead of serving a 304 with stale data.
    const items = [...result.items] as ReadonlyArray<{
      id?: string | number | null;
      status?: string | null;
      cancelledAt?: string | null;
      checkedInAt?: string | null;
      class?: {
        startsAt?: string | null;
        title?: string | null;
        durationMin?: number | null;
      } | null;
    }>;
    const fingerprint = items
      .map((item) => {
        const id = String(item.id ?? '');
        const status = String(item.status ?? '');
        const cancelledAt = String(item.cancelledAt ?? '');
        const checkedInAt = String(item.checkedInAt ?? '');
        const startsAt = String(item.class?.startsAt ?? '');
        const title = String(item.class?.title ?? '');
        const durationMin = String(item.class?.durationMin ?? '');
        return `${id}:${status}:${cancelledAt}:${checkedInAt}:${startsAt}:${title}:${durationMin}`;
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
    return c.json({ items: items as unknown[], nextCursor: result.nextCursor }, 200);
  });

  return router;
}
