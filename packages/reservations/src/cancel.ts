/**
 * Reservation cancellation use case with atomic waitlist promotion.
 *
 * Task 6.5 of the Athlya implementation plan. Implements Requirement
 * 9 (and the parts of Requirement 10 that govern the legal edges out
 * of `confirmed` / `waitlist`) exactly as written in Algorithm 2 of
 * the design document:
 *
 *   - 9.1 — stamp `status = 'cancelled'` and `cancelled_at = now()`
 *           on a reservation the caller owns, provided the class
 *           starts at least 2 hours in the future.
 *   - 9.2 — reject with `cancellation_window_closed` when
 *           `now > startsAt - 2h`.
 *   - 9.3 — when a **confirmed** reservation is cancelled and at
 *           least one `waitlist` row exists for the same class, the
 *           oldest one (FIFO by `created_at`) is promoted to
 *           `confirmed` inside the same transaction and a
 *           `reservation.promoted` event is emitted.
 *   - 9.4 — when a **confirmed** reservation is cancelled and no
 *           waitlist exists, the Redis `class:{id}:remaining`
 *           counter is incremented by 1.
 *   - 9.5 — exactly one `reservation.cancelled` event is emitted on
 *           every successful cancellation.
 *   - 10.1/10.3 — only transitions out of `confirmed` or `waitlist`
 *           are accepted; any other current status surfaces as
 *           `invalid_transition`.
 *
 * The service is deliberately a *pure function over injected ports*.
 * It never throws on expected business failures — instead it returns
 * a discriminated {@link CancelReservationResult} union. The API
 * gateway maps each `code` to the right HTTP status + Problem Details
 * envelope (Requirement 14.6); that mapping is not this module's
 * concern.
 *
 * ### Why keep the counter increment OUTSIDE the transaction?
 *
 * Redis and Postgres are not atomic together. If we incremented the
 * Redis counter inside the `withTransaction` callback and the commit
 * later failed, we would leave Redis believing there is a free seat
 * that the database still counts as confirmed — the exact "ghost
 * slot" Requirement 8.3's capacity invariant forbids. By running
 * `incrRemaining` only after `withTransaction` has *resolved* (i.e.
 * the commit succeeded), a failure on the Redis side leaves the
 * counter stale-low at worst, which cannot break capacity.
 *
 * The design document frames this as "counter compensations
 * unnecessary because we only `INCR` on the no-waitlist branch, so if
 * the tx fails we simply don't `INCR`". This module implements that
 * rule literally.
 */

import { isClassCapacityExceeded } from './book.js';
import { canTransition, type ReservationStatus } from './state-machine.js';

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Time constants                                                     */
/* ------------------------------------------------------------------ */

/**
 * Width of the cancellation window in milliseconds. Requirement 9.1:
 * the member can cancel up to exactly 2 hours before `startsAt`.
 *
 * Exported so route handlers and integration tests can reuse the
 * canonical value without redefining `2 * 60 * 60 * 1000`.
 */
export const CANCELLATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Minimal class projection                                           */
/* ------------------------------------------------------------------ */

/**
 * Subset of `classes` columns the cancellation use case needs.
 *
 * Declared structurally rather than importing {@link ClassRow}
 * directly so the repo can project only what is required (a single
 * column — `starts_at`) and so unit tests can construct the
 * projection without seeding every unrelated column. Any full
 * `ClassRow` structurally satisfies this shape.
 */
export interface ClassForCancel {
  readonly startsAt: Date;
}

/* ------------------------------------------------------------------ */
/*  Outbox event shape                                                 */
/* ------------------------------------------------------------------ */

/**
 * Payload common to both `reservation.cancelled` and
 * `reservation.promoted` — mirrors `ReservationLifecyclePayloadSchema`
 * from `@athlya/shared/events`.
 *
 * Kept as a plain `interface` (not imported from the Zod schema) so
 * this module stays free of any runtime dependency on `zod` at the
 * type level; the publisher adapter in the API layer re-parses the
 * envelope against the schema before handing it to the queue.
 */
export interface CancelLifecyclePayload {
  readonly reservationId: string;
  readonly classId: string;
  readonly userId: string;
}

/**
 * Shape the service hands to {@link CancelRepo.insertOutbox}. Matches
 * {@link OutboxEvent} from `@athlya/db/outbox` — repeated here so
 * `@athlya/reservations` does not take a direct dependency on the
 * persistence layer for its public port.
 *
 * `eventType` is narrowed to the two event names this use case emits;
 * any future event family added by a neighbouring service goes
 * through its own helper and does not flow through this port.
 */
export interface CancelOutboxEvent {
  readonly eventId: string;
  readonly eventType: 'reservation.cancelled' | 'reservation.promoted';
  readonly payload: CancelLifecyclePayload;
  readonly occurredAt: Date;
}

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Transactional repository port for {@link cancelReservation}.
 *
 * Opaque transaction token
 * ------------------------
 * `withTransaction` hands back an implementation-specific `tx` value
 * (a Drizzle transaction in production, a `vi.fn()` sentinel in unit
 * tests). The service never inspects that value — it only threads it
 * through to the other repo methods. Typing it as `unknown` keeps
 * this package free of any dependency on Drizzle's types while still
 * forcing callers to go through `withTransaction` to obtain one.
 *
 * Contract of `withTransaction(fn)`
 *   - MUST open a single database transaction and pass a token to
 *     `fn`.
 *   - On `fn` resolution MUST commit the transaction and return the
 *     resolved value. A resolved `fn` that performed no writes still
 *     commits cleanly (the SELECT FOR UPDATE rows are released).
 *   - On `fn` rejection MUST rollback the transaction and rethrow the
 *     error. The service relies on this behaviour to let unexpected
 *     repo failures bubble up to the API gateway's global error
 *     handler.
 *
 * Contract of the other methods
 *   - `findReservationForUpdate` MUST issue `SELECT ... FOR UPDATE`
 *     filtered by `(id, user_id)` and return `null` when either the
 *     row is missing or `user_id` does not match. Collapsing both
 *     "missing" and "wrong owner" into `null` lets the service map
 *     them to the same `not_found` code without leaking ownership
 *     information — the API cannot accidentally tell an attacker
 *     "this reservation exists but you don't own it".
 *   - `findClassForUpdate` MUST issue `SELECT ... FOR UPDATE` on
 *     `classes` and project at least `starts_at`. Returning `null`
 *     signals the row is missing or soft-deleted; the service treats
 *     that as `not_found`.
 *   - `updateReservationStatus` MUST run a single `UPDATE` that stamps
 *     `status` and the appropriate timestamp column (`cancelled_at`
 *     for `'cancelled'`, nothing else for `'confirmed'`) and return
 *     the updated row.
 *   - `findOldestWaitlistForClass` MUST issue
 *     `SELECT * FROM reservations WHERE class_id = $1 AND status =
 *     'waitlist' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP
 *     LOCKED`. The `SKIP LOCKED` hint is critical: two concurrent
 *     cancellations racing to promote the same waiter must each see
 *     a different row (one promotes, the other finds `null` and
 *     increments the counter instead).
 *   - `insertOutbox` MUST append the event to the `outbox` table
 *     within the caller's transaction; any failure MUST bubble up so
 *     the surrounding transaction rolls back (Req 16.3).
 */
export interface CancelRepo {
  withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  findReservationForUpdate(
    tx: unknown,
    reservationId: string,
    userId: string,
  ): Promise<ReservationRow | null>;

  findClassForUpdate(tx: unknown, classId: string): Promise<ClassForCancel | null>;

  updateReservationStatus(
    tx: unknown,
    reservationId: string,
    status: ReservationStatus,
    stampedAt: Date,
  ): Promise<ReservationRow>;

  findOldestWaitlistForClass(tx: unknown, classId: string): Promise<ReservationRow | null>;

  insertOutbox(tx: unknown, event: CancelOutboxEvent): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Counter port                                                       */
/* ------------------------------------------------------------------ */

/**
 * Narrow side-channel the service uses to bump the Redis-backed
 * `class:{id}:remaining` counter (see task 6.1) when a confirmed
 * reservation is cancelled and no waitlist can absorb the freed seat
 * (Requirement 9.4).
 *
 * Deliberately separate from the full {@link RemainingCounter} in
 * `./counter.ts` so:
 *   - the service only advertises the one method it needs (no
 *     accidental `decr` from this use case), and
 *   - unit tests can inject a `vi.fn()` double without bringing
 *     Upstash's `Redis` client into the test runtime.
 *
 * Production wires this to the production `RemainingCounter` via a
 * trivial adapter at the API gateway layer:
 *
 * ```ts
 * const cancelCounter: CancelCounter = {
 *   incrRemaining: async (classId) => {
 *     await counter.incr(classId);
 *   },
 * };
 * ```
 */
export interface CancelCounter {
  /**
   * Atomically increment `class:{classId}:remaining` by 1. The
   * service does not read the returned value — a successful
   * resolution is enough.
   */
  incrRemaining(classId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Input / result types                                               */
/* ------------------------------------------------------------------ */

/**
 * Injectable UUID factory for the outbox event ids. Defaults to
 * `crypto.randomUUID` when available. Exposed so tests can pin the
 * generated ids for deterministic assertions.
 */
export type NewEventId = () => string;

/**
 * Full argument set for {@link cancelReservation}. Named-parameter
 * style for ergonomics at the call site.
 */
export interface CancelReservationInput {
  readonly reservationId: string;
  readonly userId: string;
  readonly repo: CancelRepo;
  readonly counter: CancelCounter;
  /**
   * Injectable clock. Unix-ms to match `Date.now()` and stay
   * aligned with the rest of the `@athlya/reservations` services
   * (see `./checkin.ts`). Defaults to `Date.now`. Tests pin it.
   */
  readonly clock?: () => number;
  /** Defaults to `crypto.randomUUID`. Tests pin it. */
  readonly newEventId?: NewEventId;
}

/**
 * Success branch of {@link CancelReservationResult}.
 *
 *   - `cancelled` — the reservation row after the UPDATE
 *     (`status = 'cancelled'`, `cancelled_at = now()`).
 *   - `promoted`  — the formerly-waitlisted row that was promoted to
 *     `'confirmed'` within the same transaction, or `null` when:
 *       1. the cancelled reservation was itself on the waitlist
 *          (nothing to promote — the seat was already not counted),
 *          or
 *       2. the cancelled reservation was confirmed but the class had
 *          no waitlist at that instant. In that second case the
 *          Redis remaining-seats counter has been bumped by one
 *          (Requirement 9.4).
 */
export interface CancelReservationOk {
  readonly code: 'ok';
  readonly cancelled: ReservationRow;
  readonly promoted: ReservationRow | null;
}

/**
 * Closed set of machine-readable error codes emitted by
 * {@link cancelReservation}. Matches what the API layer turns into
 * Problem Details `type`/`title` slugs and HTTP status codes:
 *
 *   - `not_found`                    → 404 (reservation missing or
 *     owned by another user — collapsed to the same code so cross-
 *     tenant probing cannot distinguish the two).
 *   - `invalid_transition`           → 422 (status is not
 *     `confirmed` or `waitlist`, e.g. already cancelled).
 *   - `cancellation_window_closed`   → 422 (now > startsAt − 2h).
 */
export type CancelReservationFailure =
  | { readonly code: 'not_found' }
  | { readonly code: 'invalid_transition' }
  | { readonly code: 'cancellation_window_closed' };

/**
 * Discriminated union returned by {@link cancelReservation}. Use the
 * `code` property to narrow.
 */
export type CancelReservationResult = CancelReservationOk | CancelReservationFailure;

/* ------------------------------------------------------------------ */
/*  Internal transaction outcome                                       */
/* ------------------------------------------------------------------ */

/**
 * Shape returned by the transactional callback. Carries `wasConfirmed`
 * and `classId` so the post-commit step can decide whether to
 * increment the Redis counter without re-reading the row. Kept
 * internal — the public result type strips these fields out.
 */
type TxOutcome =
  | {
      readonly code: 'ok';
      readonly cancelled: ReservationRow;
      readonly promoted: ReservationRow | null;
      readonly wasConfirmed: boolean;
      readonly classId: string;
    }
  | CancelReservationFailure;

/* ------------------------------------------------------------------ */
/*  Default event-id factory                                           */
/* ------------------------------------------------------------------ */

/**
 * Default UUID factory. Uses `globalThis.crypto.randomUUID` when
 * available (Node ≥ 19, Cloudflare Workers, modern browsers) and
 * falls back to a RFC 4122 v4 built from `Math.random` otherwise —
 * the fallback is acceptable here because outbox event ids are
 * additionally guarded by a `ON CONFLICT (event_id) DO NOTHING`
 * clause at the database level.
 */
function defaultNewEventId(): string {
  const maybeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (maybeCrypto?.randomUUID !== undefined) {
    return maybeCrypto.randomUUID();
  }
  // RFC 4122 v4 fallback — good enough under the outbox's idempotent
  // insert; never used on Node ≥ 19 or on Cloudflare Workers.
  const bytes = new Array<number>(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  // Bytes per RFC 4122 §4.4.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cancel a reservation, atomically promoting the oldest waitlisted
 * reservation when the cancelled one was `confirmed` and a waiter
 * exists.
 *
 * Flow (Algorithm 2 of design.md, numbered per Requirement 9):
 *
 *   1. Open a transaction through `repo.withTransaction`.
 *   2. `SELECT ... FOR UPDATE` the reservation by `(id, userId)`. A
 *      `null` result collapses "missing" and "wrong owner" into
 *      `not_found` so cross-tenant probing cannot tell them apart.
 *   3. `SELECT ... FOR UPDATE` the related class to read `startsAt`.
 *      A `null` result also surfaces as `not_found` (degenerate
 *      state — orphaned reservation row).
 *   4. Guard `now ≤ startsAt − 2h`. Violations surface as
 *      `cancellation_window_closed` (Requirement 9.2). The
 *      transaction commits with no writes because only SELECT FOR
 *      UPDATE reads have happened — the rows are simply unlocked.
 *   5. Guard that the current status is `'confirmed'` or `'waitlist'`
 *      and that `canTransition(current, 'cancelled')` holds. A
 *      violation surfaces as `invalid_transition` (Requirement 10.3)
 *      — in particular a reservation whose status is already
 *      `'cancelled'` or `'no_show'` lands here.
 *   6. `UPDATE reservations SET status='cancelled', cancelled_at=now()`.
 *   7. If the *original* status was `'confirmed'`, attempt to promote
 *      the oldest waitlist row for the same class via
 *      `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`. On promotion:
 *      `UPDATE status='confirmed'` and append
 *      `reservation.promoted` to the outbox **inside the same
 *      transaction** (Req 9.3). The Redis counter stays unchanged —
 *      the seat is simply re-consumed by the promoted waiter.
 *   8. If the original status was `'waitlist'`, no promotion is
 *      attempted and the Redis counter stays untouched (the seat was
 *      never counted against capacity to begin with).
 *   9. Append `reservation.cancelled` to the outbox exactly once
 *      inside the transaction (Req 9.5).
 *  10. Commit. After the commit has succeeded: if the original status
 *      was `'confirmed'` AND no promotion happened, bump
 *      `class:{id}:remaining` by 1 (Req 9.4). The counter call runs
 *      *after* the transaction resolves so a commit failure never
 *      leaves Redis counting a seat that the database still holds as
 *      confirmed.
 */
export async function cancelReservation(
  input: CancelReservationInput,
): Promise<CancelReservationResult> {
  const { reservationId, userId, repo, counter } = input;
  const nowMs = (input.clock ?? Date.now)();
  const now = new Date(nowMs);
  const newEventId = input.newEventId ?? defaultNewEventId;

  const outcome: TxOutcome = await repo.withTransaction(async (tx) => {
    // Step 2 — locate and lock the reservation. `null` for either
    // "missing" or "wrong owner" is intentional: collapsing both
    // into `not_found` denies an attacker a cross-tenant probe.
    const reservation = await repo.findReservationForUpdate(tx, reservationId, userId);
    if (reservation === null) {
      return { code: 'not_found' };
    }

    // Step 3 — locate and lock the class to read `startsAt`. A
    // missing class row with a dangling reservation is a
    // degenerate state (FK cascade or soft-delete race); treat
    // it the same as "no reservation to cancel".
    const classRow = await repo.findClassForUpdate(tx, reservation.classId);
    if (classRow === null) {
      return { code: 'not_found' };
    }

    // Step 4 — 2-hour cancellation window. Strict `>`: cancelling
    // at exactly `startsAt - 2h` is legal per Requirement 9.1
    // ("at least 2 hours after now()" — the boundary is closed
    // on the user's side).
    const cutoffMs = classRow.startsAt.getTime() - CANCELLATION_WINDOW_MS;
    if (nowMs > cutoffMs) {
      return { code: 'cancellation_window_closed' };
    }

    // Step 5 — state-machine guard. The explicit membership test
    // is the authoritative gate (`cancelled → cancelled` would
    // pass `canTransition` on same-state no-op, which is *not*
    // what we want here); the `canTransition` call is kept as
    // defense-in-depth so any future addition to the legal
    // transition graph cannot accidentally unlock a new path
    // into cancellation from this service.
    if (reservation.status !== 'confirmed' && reservation.status !== 'waitlist') {
      return { code: 'invalid_transition' };
    }
    if (!canTransition(reservation.status, 'cancelled')) {
      return { code: 'invalid_transition' };
    }

    const wasConfirmed = reservation.status === 'confirmed';

    // Step 6 — stamp the cancellation.
    const cancelled = await repo.updateReservationStatus(tx, reservation.id, 'cancelled', now);

    // Step 7 — waitlist promotion. Runs only when the cancelled
    // reservation was the one actually occupying a seat; a
    // waitlist-originated cancellation never triggers a promotion
    // (Req 9.3 speaks of "a confirmed reservation [that] is
    // successfully cancelled").
    let promoted: ReservationRow | null = null;
    if (wasConfirmed) {
      const nextWaiter = await repo.findOldestWaitlistForClass(tx, reservation.classId);
      if (nextWaiter !== null) {
        try {
          promoted = await repo.updateReservationStatus(tx, nextWaiter.id, 'confirmed', now);
          await repo.insertOutbox(tx, {
            eventId: newEventId(),
            eventType: 'reservation.promoted',
            payload: {
              reservationId: promoted.id,
              classId: promoted.classId,
              userId: promoted.userId,
            },
            occurredAt: now,
          });
        } catch (err) {
          if (!isClassCapacityExceeded(err)) {
            throw err;
          }
        }
      }
    }

    // Step 9 — exactly one `reservation.cancelled` outbox row per
    // successful cancellation (Req 9.5). Emitted from within the
    // transaction so the event + state change are durable
    // together (Req 16.3).
    await repo.insertOutbox(tx, {
      eventId: newEventId(),
      eventType: 'reservation.cancelled',
      payload: {
        reservationId: cancelled.id,
        classId: cancelled.classId,
        userId: cancelled.userId,
      },
      occurredAt: now,
    });

    return {
      code: 'ok',
      cancelled,
      promoted,
      wasConfirmed,
      classId: reservation.classId,
    };
  });

  // Non-ok branches propagate straight through.
  if (outcome.code !== 'ok') {
    return outcome;
  }

  // Step 10 — post-commit counter bump. Only bumps on the
  // "confirmed without waitlist" branch; a promotion immediately
  // re-consumed the seat (counter unchanged), and a waitlist-origin
  // cancellation never occupied a seat (counter unchanged).
  if (outcome.wasConfirmed && outcome.promoted === null) {
    await counter.incrRemaining(outcome.classId);
  }

  return {
    code: 'ok',
    cancelled: outcome.cancelled,
    promoted: outcome.promoted,
  };
}
