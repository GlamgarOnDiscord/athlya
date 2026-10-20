/**
 * Seat holds (issue #723, phase B of #713).
 *
 * A hold keeps one seat of a class for a bounded time while a client
 * finishes something before booking (a checkout, a slow confirmation
 * step). It is a `pending` reservation row with a `hold_expires_at`
 * (migration 0050). The database owns every guarantee:
 *
 *   - the capacity trigger counts confirmed rows plus unexpired holds,
 *     under the class row lock, so `confirmed + active holds <=
 *     capacity` at every committed instant, and a hold stops counting
 *     the instant it expires, before any sweep runs;
 *   - a hold must expire within {@link MAX_HOLD_TTL_SECONDS}, can never
 *     be extended or reopened, and an expired hold cannot be confirmed;
 *   - one live row (confirmed, waitlist or pending) per member and
 *     class.
 *
 * {@link placeHold} mirrors {@link bookClass}: the same Redis `DECR`
 * pre-filter, then one transaction that locks the class (start time,
 * optional `classVersion` fence), releases the member's own expired
 * hold and inserts the new one. A full class is refused (`class_full`)
 * rather than waitlisted: a hold is only worth taking for a seat.
 *
 * {@link confirmHold} turns an active hold into a `confirmed`
 * reservation with its `reservation.created` event. The seat was
 * already counted, so confirming never races other bookings for it.
 *
 * Releasing a hold goes through `cancelReservation`. An expired hold
 * is cancelled by the cron sweep (`reservation_sweep_holds_and_promote`),
 * which also hands the freed seats to the waitlist; the Redis counter
 * the hold decremented is healed by the reconcile pass that follows.
 */

import {
  BookingClosedError,
  assertClassOpen,
  isClassCapacityExceeded,
  isHoldExpired,
  isUniqueViolation,
  loadExistingBooking,
  type BookClock,
  type BookingCounter,
  type BookingEventPublisher,
  type BookingLogger,
  type BookingRepo,
  type BookingReservationRow,
  type BookingTx,
} from './book.js';

/** Default hold length: long enough for a checkout, short enough to free a seat fast. */
export const DEFAULT_HOLD_TTL_SECONDS = 600;

/**
 * Longest hold the database accepts (`enforce_class_capacity()`,
 * migration 0050). Kept in step with the trigger.
 */
export const MAX_HOLD_TTL_SECONDS = 1800;

/** A hold as the API reports it. */
export interface HeldSeat {
  readonly reservationId: string;
  readonly classId: string;
  readonly expiresAt: Date;
}

/** Persistence needed by {@link placeHold} and {@link confirmHold}. */
export interface HoldRepo extends Pick<
  BookingRepo,
  | 'findClass'
  | 'readClassClock'
  | 'withTransaction'
  | 'lockClassForBooking'
  | 'findOwnHold'
  | 'confirmHold'
  | 'releaseHold'
  | 'insertOutbox'
  | 'findExistingConfirmedOrWaitlistReservation'
  | 'countWaitlistAhead'
> {
  /**
   * Insert a `pending` row for `(classId, userId)` expiring
   * `ttlSeconds` after the transaction's `now()`. Throws a
   * `ClassCapacityExceededError` when the class has no free seat and
   * a `UniqueViolationError` when the member already holds a live row.
   */
  insertHold(
    tx: BookingTx,
    input: { readonly classId: string; readonly userId: string; readonly ttlSeconds: number },
  ): Promise<HeldSeat>;

  /**
   * The caller's reservation `reservationId`, locked `FOR UPDATE`, or
   * `null` when it is missing or owned by someone else.
   */
  findReservationForUpdate(
    tx: BookingTx,
    reservationId: string,
    userId: string,
  ): Promise<BookingReservationRow | null>;
}

/** Input of {@link placeHold}. */
export interface PlaceHoldInput {
  readonly classId: string;
  readonly userId: string;
  readonly studioId: string;
  /** The class `version` the member saw; refused with `class_changed` when stale. */
  readonly classVersion?: number;
  /** Defaults to {@link DEFAULT_HOLD_TTL_SECONDS}; at most {@link MAX_HOLD_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  readonly repo: HoldRepo;
  readonly counter: BookingCounter;
  /** Test seam replacing the database clock for `class_in_past`. */
  readonly clock?: BookClock;
  /** Defaults to `console`. */
  readonly logger?: BookingLogger;
}

/**
 * Result of {@link placeHold}:
 *
 *   - `held`           : a new hold; the seat is the member's until `expiresAt`.
 *   - `already_held`   : the member already holds an active hold on the
 *                        class (a retry): that hold, unchanged.
 *   - `already_booked` : the member already has a confirmed or waitlist
 *                        row on the class; `position` for a waiter.
 *   - `class_full`     : no free seat; nothing written.
 *   - `class_changed`, `class_in_past`, `class_not_found`,
 *     `counter_unavailable`: as for a booking.
 */
export type PlaceHoldResult =
  | { readonly code: 'held'; readonly hold: HeldSeat }
  | { readonly code: 'already_held'; readonly hold: HeldSeat }
  | {
      readonly code: 'already_booked';
      readonly reservation: BookingReservationRow;
      readonly position?: number;
    }
  | { readonly code: 'class_full' }
  | { readonly code: 'class_changed' }
  | { readonly code: 'class_in_past' }
  | { readonly code: 'class_not_found' }
  | { readonly code: 'counter_unavailable' };

const consoleLogger: BookingLogger = {
  error: (msg, ctx) => {
    console.error(msg, ctx ?? {});
  },
};

/** Compensating INCR that never masks the caller's outcome (see `book.ts`). */
async function compensate(
  counter: BookingCounter,
  logger: BookingLogger,
  classId: string,
  reason: string,
): Promise<void> {
  try {
    await counter.incrRemaining(classId);
  } catch (err) {
    logger.error('hold: compensating INCR failed', {
      classId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hold a seat of `classId` for `ttlSeconds`.
 *
 *   0. Pre-flight without side effects: class visible, not started, and
 *      `classVersion` (when sent) still current.
 *   1. Redis `DECR` pre-filter, seeded from the capacity; a negative
 *      value is `class_full` (compensated).
 *   2. One transaction: re-check the start time (and, with
 *      `classVersion`, the version under the class row lock); settle the member's own hold (an active one is the
 *      answer, an expired one is released); insert the hold. The
 *      capacity trigger and the live unique index are authoritative.
 *   3. Any failure compensates the `DECR`. The trigger refusing is
 *      `class_full`; a live row of another status is `already_booked`.
 */
export async function placeHold(input: PlaceHoldInput): Promise<PlaceHoldResult> {
  const { classId, userId, classVersion, repo, counter, clock } = input;
  const logger = input.logger ?? consoleLogger;
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_HOLD_TTL_SECONDS) {
    throw new RangeError(`hold ttl must be an integer in [1, ${String(MAX_HOLD_TTL_SECONDS)}] s`);
  }

  const classRow = await repo.findClass(classId);
  if (classRow === null) {
    return { code: 'class_not_found' };
  }
  const nowMs = clock !== undefined ? clock() : (classRow.dbNow?.getTime() ?? Date.now());
  if (classRow.startsAt.getTime() <= nowMs) {
    return { code: 'class_in_past' };
  }
  if (classVersion !== undefined && classRow.version !== classVersion) {
    return { code: 'class_changed' };
  }

  let remaining: number;
  try {
    remaining = await counter.decrRemainingOrInit(classId, classRow.capacity);
  } catch {
    return { code: 'counter_unavailable' };
  }
  if (remaining < 0) {
    await compensate(counter, logger, classId, 'counter_exhausted');
    return { code: 'class_full' };
  }

  try {
    const outcome = await repo.withTransaction(
      async (tx): Promise<{ readonly fresh: boolean; readonly hold: HeldSeat }> => {
        await assertClassOpen(repo, tx, classId, clock, classVersion);
        const own = await repo.findOwnHold(tx, classId, userId);
        if (own !== null && own.expiresAt.getTime() > own.now.getTime()) {
          return {
            fresh: false,
            hold: { reservationId: own.id, classId, expiresAt: own.expiresAt },
          };
        }
        if (own !== null) {
          await repo.releaseHold(tx, own.id);
        }
        return { fresh: true, hold: await repo.insertHold(tx, { classId, userId, ttlSeconds }) };
      },
    );
    if (!outcome.fresh) {
      await compensate(counter, logger, classId, 'already_held');
      return { code: 'already_held', hold: outcome.hold };
    }
    return { code: 'held', hold: outcome.hold };
  } catch (err) {
    await compensate(counter, logger, classId, 'hold_tx_failed');
    if (err instanceof BookingClosedError) {
      return { code: err.result };
    }
    if (isClassCapacityExceeded(err)) {
      return { code: 'class_full' };
    }
    if (isUniqueViolation(err)) {
      return existingLiveRow(repo, classId, userId);
    }
    throw err;
  }
}

/**
 * The live row that made a hold insert collide: a concurrent hold of
 * the same member (`already_held`), else its confirmed or waitlist row.
 */
async function existingLiveRow(
  repo: HoldRepo,
  classId: string,
  userId: string,
): Promise<PlaceHoldResult> {
  const own = await repo.withTransaction((tx) => repo.findOwnHold(tx, classId, userId));
  if (own !== null && own.expiresAt.getTime() > own.now.getTime()) {
    return {
      code: 'already_held',
      hold: { reservationId: own.id, classId, expiresAt: own.expiresAt },
    };
  }
  return loadExistingBooking(repo, classId, userId);
}

/** Input of {@link confirmHold}. */
export interface ConfirmHoldInput {
  readonly reservationId: string;
  readonly userId: string;
  readonly studioId: string;
  readonly repo: HoldRepo;
  readonly publisher: BookingEventPublisher;
}

/**
 * Result of {@link confirmHold}:
 *
 *   - `confirmed`         : the hold is now a confirmed reservation.
 *   - `already_confirmed` : the reservation was already confirmed (a
 *                           retry): the row, unchanged, no new event.
 *   - `hold_expired`      : the hold expired, or was released or swept.
 *   - `not_a_hold`        : a waitlist or no-show row.
 *   - `not_found`         : missing, or owned by someone else.
 */
export type ConfirmHoldResult =
  | { readonly code: 'confirmed'; readonly reservation: BookingReservationRow }
  | { readonly code: 'already_confirmed'; readonly reservation: BookingReservationRow }
  | { readonly code: 'hold_expired' }
  | { readonly code: 'not_a_hold' }
  | { readonly code: 'not_found' };

/**
 * Confirm the caller's hold `reservationId`, with its
 * `reservation.created` event in the same transaction. The capacity
 * trigger refuses an expired hold (`hold_expired`); an active one
 * already owns its seat, so no other booking can take it.
 */
export async function confirmHold(input: ConfirmHoldInput): Promise<ConfirmHoldResult> {
  const { reservationId, userId, studioId, repo, publisher } = input;
  try {
    return await repo.withTransaction(async (tx): Promise<ConfirmHoldResult> => {
      const row = await repo.findReservationForUpdate(tx, reservationId, userId);
      if (row === null) {
        return { code: 'not_found' };
      }
      if (row.status === 'confirmed') {
        return { code: 'already_confirmed', reservation: row };
      }
      if (row.status === 'cancelled') {
        return { code: 'hold_expired' };
      }
      if (row.status !== 'pending') {
        return { code: 'not_a_hold' };
      }
      const reservation = await repo.confirmHold(tx, row.id);
      await repo.insertOutbox(
        tx,
        publisher.buildReservationCreated({
          reservationId: reservation.id,
          classId: reservation.classId,
          userId,
          studioId,
        }),
      );
      return { code: 'confirmed', reservation };
    });
  } catch (err) {
    if (isHoldExpired(err)) {
      return { code: 'hold_expired' };
    }
    throw err;
  }
}
