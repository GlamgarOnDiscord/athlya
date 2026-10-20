/**
 * `bookClass` — Algorithm 1 from the Athlya design document.
 *
 * Implements Requirement 8.1 through 8.6 of the platform spec: booking
 * a class with zero double-booking under contention, idempotent retries,
 * automatic waitlist fallback on capacity exhaustion, and a
 * publish-on-commit guarantee via the transactional outbox.
 *
 * The two-phase protocol is the single most important piece of code in
 * the reservations domain:
 *
 *   1. Redis `DECR` on `class:{id}:remaining` as an atomic optimistic
 *      "claim a seat" primitive. No lock, no round-trip to Postgres:
 *      this is the hot path that lets the service hit p99 < 500 ms
 *      under a thundering-herd popular class opening.
 *
 *   2. Postgres transaction: `BEGIN`, read the class start time against
 *      the database clock, `INSERT` the reservation row, `INSERT` the
 *      outbox event row, `COMMIT`. The service itself takes no row
 *      lock. Two database guards are authoritative:
 *        - the `enforce_class_capacity()` trigger (migration 0008)
 *          locks the `classes` row `FOR UPDATE` and counts the
 *          confirmed rows before every confirmed INSERT or UPDATE, so
 *          concurrent confirmations of one class serialise on that
 *          lock and never exceed `capacity`;
 *        - the partial unique index on `(class_id, user_id) WHERE
 *          status IN ('confirmed', 'waitlist')` (migration 0028) stops
 *          a second live row for the same member.
 *      Redis is only an optimistic pre-filter: a wrong counter routes
 *      a member to the wrong branch, it can never oversell.
 *
 * Compensating actions are the mirror image of the Redis step:
 *
 *   - `UniqueViolation` on insert → the user already holds a row. We
 *     `INCR` Redis (we had `DECR`'d on the attempt) and return the
 *     existing row as `already_booked`. This is the idempotence
 *     property Req 8.5 relies on: a retry with the same
 *     `(userId, classId)` never creates a duplicate.
 *
 *   - Any other error inside the tx → `INCR` Redis and rethrow. The
 *     API gateway turns the rethrown error into a 5xx Problem Details
 *     envelope; the compensating `INCR` keeps the counter honest.
 *
 *   - `DECR` returned a negative value → Redis told us the class is
 *     full. We `INCR` to cancel our decrement (we haven't consumed a
 *     seat), enter the waitlist branch, and insert with
 *     `status='waitlist'` in a fresh transaction. The outbox event is
 *     `reservation.waitlisted` with the user's 1-based position.
 *
 * The module is framework-free: every I/O concern is expressed as a
 * port (`BookingRepo`, `BookingCounter`, `BookingEventPublisher`).
 * Production wires these to Drizzle / Upstash / the `publish` helper
 * from `@athlya/api/events/publish`. Unit tests replace them with
 * `vi.fn()` doubles so the suite never touches a real database or
 * Redis instance.
 *
 * Related requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6.
 */

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Opaque transaction handle. `book.ts` never inspects the runtime
 * shape — it only passes the value it receives from
 * {@link BookingRepo.withTransaction} back to the repo's other
 * methods. Declared as `unknown` so the adapter in `@athlya/api` can
 * bind it to `AthlyaTx` without this module ever importing Drizzle.
 */
/**
 * Sprint-10 SP10.1 (Vague 38, critique C2.3) — `BookingTx` is now a
 * branded opaque type instead of plain `unknown`. The `__brand`
 * tag means a caller MUST cast their concrete transaction handle
 * via `as BookingTx` (or via the adapter factory in
 * `packages/api/src/adapters/`) to satisfy the type, which catches
 * accidentally-passed `null` / `string` / wrong-tx mistakes at
 * compile time. The runtime payload remains opaque — this module
 * still doesn't depend on Drizzle.
 *
 * Why this matters: the booking algorithm is the most contention-
 * critical path in the codebase. A wrong `tx` passed to a repo method
 * would run the INSERT outside the transaction that carries the
 * tenant session variables and the outbox row. The brand is a
 * structural guard.
 */
export type BookingTx = { readonly __brand: 'BookingTx' };

/**
 * Partial projection of `classes` that the booking flow needs. We
 * only read `capacity`, `startsAt`, `version` and the two IDs — no
 * reason to pay for wider columns in the hot path.
 */
export interface BookingClassRow {
  readonly id: string;
  readonly studioId: string;
  readonly capacity: number;
  readonly startsAt: Date;
  readonly version: number;
  /**
   * Database clock read in the same statement as the row. When present
   * it replaces the Worker clock for the `class_in_past` pre-flight,
   * so a skewed isolate cannot book a class that already started.
   */
  readonly dbNow?: Date;
}

/** Class start time and database clock, read inside a booking transaction. */
export interface BookingClassClock {
  readonly startsAt: Date;
  readonly now: Date;
}

/**
 * Outbox event envelope as expected by
 * {@link BookingRepo.insertOutbox}. Mirrors the `OutboxEvent` shape
 * declared in `@athlya/db/outbox` — duplicated here so the port
 * stays framework-free. The adapter layer checks the two shapes are
 * structurally compatible at compile time.
 */
export interface BookingOutboxEvent {
  readonly eventId: string;
  readonly eventType: 'reservation.created' | 'reservation.waitlisted';
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

/**
 * Thrown by {@link BookingRepo.insertReservation} when the
 * `UNIQUE(class_id, user_id)` constraint rejects an insert. Exported
 * here so adapters that don't already have a sentinel can throw this
 * one; adapters that do (e.g. Drizzle's Postgres error mapping) can
 * either rethrow as this class or throw any error whose
 * `.code === 'UNIQUE_VIOLATION'`. {@link isUniqueViolation} below
 * accepts both paths.
 */
export class UniqueViolationError extends Error {
  public override readonly name = 'UniqueViolationError';
  /**
   * Stable machine-readable discriminator. Mirrors the string we
   * check on generic errors that come from the repo adapter.
   */
  public readonly code: 'UNIQUE_VIOLATION' = 'UNIQUE_VIOLATION' as const;

  public constructor(message = 'unique constraint violated') {
    super(message);
  }
}

/**
 * Thrown when the PostgreSQL capacity guard rejects a `confirmed`
 * insert/update because `count(confirmed) >= classes.capacity`.
 */
export class ClassCapacityExceededError extends Error {
  public override readonly name = 'ClassCapacityExceededError';
  public readonly code: 'CLASS_CAPACITY_EXCEEDED' = 'CLASS_CAPACITY_EXCEEDED' as const;

  public constructor(message = 'class capacity exceeded') {
    super(message);
  }
}

export function isClassCapacityExceeded(err: unknown): boolean {
  if (err instanceof ClassCapacityExceededError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'CLASS_CAPACITY_EXCEEDED';
}

/**
 * Permissive unique-violation detector. Accepts:
 *
 *   - an `instanceof UniqueViolationError`, or
 *   - any error-shaped value with `.code === 'UNIQUE_VIOLATION'`.
 *
 * The second path is there so a Drizzle-backed repo adapter can
 * rethrow a thin wrapper that sets the `code` property, without
 * forcing this module's `UniqueViolationError` class on every caller.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof UniqueViolationError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'UNIQUE_VIOLATION';
}

/**
 * Narrow projection of a newly-inserted or pre-existing reservation
 * row. Typed as the full `ReservationRow` from `@athlya/db/schema` so
 * the API gateway can serialise the result without a second fetch.
 */
export type BookingReservationRow = ReservationRow;

/**
 * Persistence contract needed by {@link bookClass}. The adapter in
 * `@athlya/api` binds this to Drizzle + the tenant-aware transaction
 * helper; the unit tests replace every method with a `vi.fn()`
 * double.
 *
 * All methods that take a `tx` MUST run inside the transaction
 * started by {@link BookingRepo.withTransaction}. The book flow never
 * opens a transaction itself — it always goes through
 * `withTransaction` so the adapter can apply `SET LOCAL app.user_id`
 * / `SET LOCAL app.studio_id` and the Postgres RLS filter.
 */
export interface BookingRepo {
  /**
   * Return the class row for `classId`, or `null` when the row is
   * missing, soft-deleted, or invisible under the active RLS
   * policy (e.g. wrong tenant — Req 13.5).
   *
   * The happy-path `Algorithm 1` description skips this step for
   * the hot path, but we need it to (a) enforce `startsAt > now()`
   * BEFORE touching Redis — no compensating round-trips on a
   * malformed request — and (b) return a stable `class_not_found`
   * error instead of leaking a downstream failure.
   */
  findClass(classId: string): Promise<BookingClassRow | null>;

  /**
   * Read the class start time and `now()` inside `tx`, so the
   * `class_in_past` decision uses the transaction's own clock instead
   * of the pre-flight read. `null` when the class vanished (soft
   * delete) between the pre-flight and the transaction.
   */
  readClassClock(tx: BookingTx, classId: string): Promise<BookingClassClock | null>;

  /**
   * Run `fn` inside a Postgres transaction. The adapter is
   * responsible for BEGIN/COMMIT/ROLLBACK lifecycle and for
   * applying `SET LOCAL` session variables (Req 13.1). Throwing
   * from `fn` triggers a ROLLBACK.
   */
  withTransaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T>;

  /**
   * Look up the existing reservation for `(classId, userId)` —
   * typically called after a {@link UniqueViolationError} to
   * retrieve the row the user already holds. Returns `null` only
   * if the row vanished between the failed INSERT and this SELECT
   * (e.g. a concurrent admin DELETE), in which case the book flow
   * surfaces it as a generic internal error — the invariant "a
   * unique-violation means a pre-existing row" is trusted.
   *
   * Implementations SHOULD accept rows in any non-cancelled status;
   * since migration 0028 replaced the global unique index with a
   * partial one (`WHERE status IN ('confirmed', 'waitlist')`),
   * cancelled rows no longer block the INSERT and this method is
   * only reached on a genuine double-tap or idempotent retry.
   */
  findExistingConfirmedOrWaitlistReservation(
    tx: BookingTx,
    classId: string,
    userId: string,
  ): Promise<BookingReservationRow | null>;

  /**
   * Insert a new reservation row for `(classId, userId)` with the
   * given `status`. Throws {@link UniqueViolationError} (or any
   * error with `.code === 'UNIQUE_VIOLATION'`) on the
   * `UNIQUE(class_id, user_id) WHERE status IN ('confirmed', 'waitlist')` collision.
   *
   * Any OTHER error (deadlock, DB outage, RLS rejection, …) is
   * propagated to the book flow which compensates the Redis DECR
   * and rethrows.
   */
  insertReservation(
    tx: BookingTx,
    input: {
      readonly classId: string;
      readonly userId: string;
      readonly status: 'confirmed' | 'waitlist';
    },
  ): Promise<BookingReservationRow>;

  /**
   * Insert the outbox event row within the active transaction so
   * the event either commits together with the reservation row or
   * is rolled back together with it (Req 16.3). Implementations
   * typically delegate to `insertOutbox` from `@athlya/db/outbox`.
   */
  insertOutbox(tx: BookingTx, event: BookingOutboxEvent): Promise<void>;

  /**
   * Count waitlisted rows of the given class that come before
   * `reservation` in promotion order (`created_at`, then `id`), so
   * two waiters with the same `created_at` never share a position.
   * Used to compute the 1-based position returned with the
   * `waitlisted` result: `position = countWaitlistAhead(...) + 1`.
   *
   * SHOULD match the SQL
   * `SELECT COUNT(*) FROM reservations
   *    WHERE class_id = $1
   *      AND status = 'waitlist'
   *      AND (created_at, id) < ($2, $3)`.
   */
  countWaitlistAhead(
    tx: BookingTx,
    classId: string,
    reservation: { readonly id: string; readonly createdAt: Date },
  ): Promise<number>;
}

/**
 * Redis seat-counter port. Matches the relevant slice of
 * {@link RemainingCounter} from `./counter.ts` — declared locally so
 * the port name stays semantically meaningful (`decrRemaining` /
 * `incrRemaining`) and so tests can wire the two methods without
 * pulling the full interface.
 */
export interface BookingCounter {
  /**
   * Atomically decrement `class:{classId}:remaining`; return the new value (may be negative).
   *
   * WARNING: a plain DECR on an absent key creates it at 0 and returns
   * -1, falsely signalling "capacity exhausted". Prefer
   * {@link decrRemainingOrInit} unless the key is guaranteed to exist.
   */
  decrRemaining(classId: string): Promise<number>;
  /**
   * Seed the counter to `capacity` via SETNX (absent key only), then
   * atomically DECR and return the new value. Prevents an absent/evicted
   * Redis key from forcing waitlist while PostgreSQL capacity is available
   * (issue #412). The PostgreSQL capacity trigger remains the authoritative
   * guard; an optimistic counter is corrected by the reconcile job.
   */
  decrRemainingOrInit(classId: string, capacity: number): Promise<number>;
  /** Atomically increment `class:{classId}:remaining`; return the new value. */
  incrRemaining(classId: string): Promise<number>;
}

/**
 * Builds typed event envelopes for the reservation lifecycle.
 *
 * The port is responsible for generating `eventId` (UUID v4/v7) and
 * `occurredAt`; it does NOT write to the outbox — that's
 * {@link BookingRepo.insertOutbox}'s job. Keeping the two concerns
 * apart means the domain code stays free of `crypto.randomUUID()`
 * and `Date` constructors, which in turn keeps it trivially
 * test-seedable: a fixture publisher can return deterministic IDs and
 * timestamps without monkey-patching globals.
 *
 * The `eventType` values line up with the discriminated union in
 * `@athlya/shared/events`. Consumers (Notifications, Analytics)
 * dedup on `eventId` per Req 17.4.
 */
export interface BookingEventPublisher {
  /**
   * Build the `reservation.created` outbox envelope emitted on a
   * successful confirmed booking (Req 8.1).
   */
  buildReservationCreated(input: {
    readonly reservationId: string;
    readonly classId: string;
    readonly userId: string;
    readonly studioId: string;
  }): BookingOutboxEvent;

  /**
   * Build the `reservation.waitlisted` outbox envelope emitted
   * when capacity was full and the user joined the waitlist (Req
   * 8.2). `position` is 1-based to match the event payload schema.
   */
  buildReservationWaitlisted(input: {
    readonly reservationId: string;
    readonly classId: string;
    readonly userId: string;
    readonly studioId: string;
    readonly position: number;
  }): BookingOutboxEvent;
}

/* ------------------------------------------------------------------ */
/*  Result type                                                        */
/* ------------------------------------------------------------------ */

/**
 * Success outcome: a fresh `confirmed` reservation was written. The
 * `remaining` field is the value returned by Redis `DECR` on the
 * claim — always `≥ 0` on this branch (a negative `DECR` enters the
 * waitlist path instead). Callers that need to refresh a UI counter
 * can use it directly without re-reading Redis.
 */
export interface BookConfirmed {
  readonly code: 'ok';
  readonly reservation: BookingReservationRow;
  readonly remaining: number;
}

/**
 * The user joined the waitlist. `position` is 1-based (1 means
 * "first in line"), matching both the design document and the
 * `reservation.waitlisted` event payload.
 */
export interface BookWaitlisted {
  readonly code: 'waitlisted';
  readonly reservation: BookingReservationRow;
  readonly position: number;
}

/**
 * Idempotent replay path: the user already holds a reservation for
 * this class. Covers both the "double-tap" case (same request fired
 * twice in flight) and the "network hiccup retry" case. The returned
 * row is the existing one; no second event is published.
 */
export interface BookAlreadyBooked {
  readonly code: 'already_booked';
  readonly reservation: BookingReservationRow;
  /** 1-based waitlist position, present only when the existing row is a waitlist row. */
  readonly position?: number;
}

/**
 * Business failures. Kept short and stable — the API gateway maps
 * each code to an HTTP status + Problem Details slug:
 *
 *   - `class_in_past`        → 422 with `class_in_past`   (Req 8.6)
 *   - `class_not_found`      → 404 (RLS: other studio or missing row)
 *   - `counter_unavailable`  → 503 (Redis down; client should retry)
 */
export interface BookClassInPast {
  readonly code: 'class_in_past';
}
export interface BookClassNotFound {
  readonly code: 'class_not_found';
}
export interface BookCounterUnavailable {
  readonly code: 'counter_unavailable';
}

/**
 * Discriminated union returned by {@link bookClass}. Every branch
 * carries a stable `code` the gateway uses to build the response.
 *
 * Transient failures (DB outage, RLS violation on insert, …) are NOT
 * modelled here — they propagate as thrown errors which the gateway's
 * global handler turns into 5xx Problem Details envelopes.
 * Redis unavailability is modelled explicitly so the gateway can
 * return a retryable 503 with a proper code rather than an opaque 5xx.
 */
export type BookResult =
  | BookConfirmed
  | BookWaitlisted
  | BookAlreadyBooked
  | BookClassInPast
  | BookClassNotFound
  | BookCounterUnavailable;

/* ------------------------------------------------------------------ */
/*  Input                                                              */
/* ------------------------------------------------------------------ */

/**
 * Dependency-injected clock, in Unix-ms to match `Date.now()`.
 * Tests pin it so the "in the past" branch is deterministic.
 */
export type BookClock = () => number;

/** Logger for failures the flow survives (a lost compensating INCR). */
export interface BookingLogger {
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const consoleBookingLogger: BookingLogger = {
  error: (msg, ctx) => {
    console.error(msg, ctx ?? {});
  },
};

/**
 * Argument bundle for {@link bookClass}. Destructured inside the
 * function body so call sites read as named parameters.
 */
export interface BookClassInput {
  readonly classId: string;
  readonly userId: string;
  readonly studioId: string;
  /**
   * Optional idempotency key from the `Idempotency-Key` header. Not
   * used directly by this function — the API gateway's middleware
   * is responsible for the header-level dedup layer (Req 20.1).
   * The key is accepted here so future adapters can attach it to
   * observability spans and to audit-log entries without changing
   * the signature.
   */
  readonly idempotencyKey?: string;
  readonly repo: BookingRepo;
  readonly counter: BookingCounter;
  readonly publisher: BookingEventPublisher;
  /**
   * Test seam. When supplied it replaces the database clock for every
   * `class_in_past` decision; production leaves it unset so the
   * decision uses Postgres `now()`.
   */
  readonly clock?: BookClock;
  /** Defaults to `console`. */
  readonly logger?: BookingLogger;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Thrown inside a booking transaction when the class can no longer be
 * booked (started, or soft-deleted since the pre-flight). Rolls the
 * transaction back; {@link bookClass} turns it into a result code.
 */
class BookingClosedError extends Error {
  public override readonly name = 'BookingClosedError';
  public constructor(public readonly result: 'class_in_past' | 'class_not_found') {
    super(result);
  }
}

/**
 * Re-check, inside `tx`, that the class still exists and has not
 * started. Uses the injected test clock when there is one, else the
 * transaction's `now()`.
 */
async function assertClassOpen(
  repo: BookingRepo,
  tx: BookingTx,
  classId: string,
  clock: BookClock | undefined,
): Promise<void> {
  const times = await repo.readClassClock(tx, classId);
  if (times === null) {
    throw new BookingClosedError('class_not_found');
  }
  const nowMs = clock !== undefined ? clock() : times.now.getTime();
  if (times.startsAt.getTime() <= nowMs) {
    throw new BookingClosedError('class_in_past');
  }
}

/**
 * Compensating INCR that never masks the caller's outcome. A failure
 * leaves the counter one seat low (a false "full", never an
 * oversell: Postgres stays authoritative) until the reconcile cron
 * heals it, so it is logged for the drift alert instead of thrown.
 */
async function compensate(
  counter: BookingCounter,
  logger: BookingLogger,
  classId: string,
  reason: string,
): Promise<void> {
  try {
    await counter.incrRemaining(classId);
  } catch (err) {
    logger.error('booking: compensating INCR failed', {
      classId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load the live row the member already holds after a unique violation,
 * with its waitlist position when it is a waitlist row, so the replay
 * answers with the real state instead of assuming `confirmed`.
 */
async function loadExistingBooking(
  repo: BookingRepo,
  classId: string,
  userId: string,
): Promise<BookAlreadyBooked> {
  return repo.withTransaction(async (tx) => {
    const existing = await repo.findExistingConfirmedOrWaitlistReservation(tx, classId, userId);
    if (existing === null) {
      // A unique violation means a live row existed when the INSERT
      // ran; it vanishing before this read is a concurrent cancel.
      // Surface a 5xx rather than invent a state.
      throw new Error(
        `bookClass: unique-violation on (${classId}, ${userId}) but no live reservation found`,
      );
    }
    if (existing.status !== 'waitlist') {
      return { code: 'already_booked', reservation: existing };
    }
    const ahead = await repo.countWaitlistAhead(tx, classId, {
      id: existing.id,
      createdAt: existing.createdAt,
    });
    return { code: 'already_booked', reservation: existing, position: ahead + 1 };
  });
}

/**
 * Book a class following Algorithm 1.
 *
 * Control flow (numbered to match the pseudo-code in `design.md`):
 *
 *   0. Pre-flight: load the class row. Short-circuit with
 *      `class_not_found` on `null` and `class_in_past` on
 *      `startsAt <= now`, where `now` is the database clock read with
 *      the row (or the injected test clock). BOTH checks run BEFORE
 *      any Redis traffic so a malformed or cross-tenant request never
 *      perturbs the counter.
 *
 *   1. Redis `DECR` on `class:{classId}:remaining`, seeded from the
 *      capacity when the key is missing. Optimistic pre-filter only.
 *
 *   2. If `DECR >= 0`: the confirmed-booking transaction re-checks the
 *      class against the transaction clock, inserts the `confirmed`
 *      row (the capacity trigger and the partial unique index are the
 *      authoritative guards) and the `reservation.created` outbox row.
 *
 *   3. Capacity trigger refused: compensate the DECR and fall through
 *      to the waitlist branch (Postgres is authoritative).
 *   4. Unique violation: the member already holds a live row.
 *      Compensate and return it as `already_booked`, with its real
 *      status and waitlist position. No second outbox event.
 *   5. Class closed inside the transaction: compensate and return
 *      `class_in_past` / `class_not_found`.
 *   6. Anything else: compensate and rethrow (5xx at the gateway).
 *
 *   7. If `DECR < 0`: compensate (no seat was consumed) and insert a
 *      `waitlist` row with its 1-based position and the
 *      `reservation.waitlisted` event.
 *
 * Every compensating INCR is best-effort and logged on failure: it can
 * only leave the counter low, which the reconcile cron heals.
 *
 * **Invariant preserved** (Req 8.3): for every class `c`,
 * `count(reservations WHERE class_id = c AND status = 'confirmed')
 *  <= c.capacity` at every committed instant. The proof rests on the
 * capacity trigger alone: it serialises confirmations of one class on
 * the class row lock and counts under that lock. Redis can be wrong in
 * either direction without breaking it.
 *
 * **Idempotence** (Req 8.4, 8.5): replaying `bookClass` with the same
 * `(userId, classId)` yields `already_booked` on the second call.
 * Combined with the gateway's `Idempotency-Key` layer this gives
 * at-most-once logical booking under arbitrarily aggressive retries.
 */
async function completeWaitlistBooking(input: {
  readonly classId: string;
  readonly userId: string;
  readonly studioId: string;
  readonly repo: BookingRepo;
  readonly publisher: BookingEventPublisher;
  readonly clock: BookClock | undefined;
}): Promise<
  Extract<
    BookResult,
    { code: 'waitlisted' | 'already_booked' | 'class_in_past' | 'class_not_found' }
  >
> {
  const { classId, userId, studioId, repo, publisher, clock } = input;

  try {
    const { reservation: waitlisted, position } = await repo.withTransaction(async (tx) => {
      await assertClassOpen(repo, tx, classId, clock);
      const row = await repo.insertReservation(tx, {
        classId,
        userId,
        status: 'waitlist',
      });
      const ahead = await repo.countWaitlistAhead(tx, classId, {
        id: row.id,
        createdAt: row.createdAt,
      });
      const pos = ahead + 1;
      const event = publisher.buildReservationWaitlisted({
        reservationId: row.id,
        classId,
        userId,
        studioId,
        position: pos,
      });
      await repo.insertOutbox(tx, event);
      return { reservation: row, position: pos };
    });

    return { code: 'waitlisted', reservation: waitlisted, position };
  } catch (err) {
    if (err instanceof BookingClosedError) {
      return { code: err.result };
    }
    if (isUniqueViolation(err)) {
      // The member already holds a live row (double tap / retry). The
      // transaction rolled back, so no second outbox event commits.
      return loadExistingBooking(repo, classId, userId);
    }
    throw err;
  }
}

export async function bookClass(input: BookClassInput): Promise<BookResult> {
  const { classId, userId, studioId, repo, counter, publisher, clock } = input;
  const logger = input.logger ?? consoleBookingLogger;

  // ---- Step 0: pre-flight (cheap, idempotent, no side-effects) ------
  const classRow = await repo.findClass(classId);
  if (classRow === null) {
    return { code: 'class_not_found' };
  }
  const nowMs = clock !== undefined ? clock() : (classRow.dbNow?.getTime() ?? Date.now());
  if (classRow.startsAt.getTime() <= nowMs) {
    return { code: 'class_in_past' };
  }

  // ---- Step 1: optimistic seat claim --------------------------------
  //
  // If Redis is unavailable we fail closed: `counter_unavailable` gives
  // the client a retryable 503 rather than an opaque 5xx. Seeding an
  // absent key to the capacity (#412) can make the counter optimistic;
  // the capacity trigger then refuses and Step 3 routes to waitlist.
  let remaining: number;
  try {
    remaining = await counter.decrRemainingOrInit(classId, classRow.capacity);
  } catch {
    return { code: 'counter_unavailable' };
  }

  if (remaining >= 0) {
    // ---- Step 2: confirmed-booking transaction --------------------
    try {
      const confirmed = await repo.withTransaction(async (tx) => {
        await assertClassOpen(repo, tx, classId, clock);
        const reservation = await repo.insertReservation(tx, {
          classId,
          userId,
          status: 'confirmed',
        });
        const event = publisher.buildReservationCreated({
          reservationId: reservation.id,
          classId,
          userId,
          studioId,
        });
        await repo.insertOutbox(tx, event);
        return reservation;
      });

      return { code: 'ok', reservation: confirmed, remaining };
    } catch (err) {
      await compensate(counter, logger, classId, 'confirmed_tx_failed');

      if (isUniqueViolation(err)) {
        // ---- Step 4: idempotent replay ------------------------
        return loadExistingBooking(repo, classId, userId);
      }
      if (isClassCapacityExceeded(err)) {
        // ---- Step 3: Postgres says full -----------------------
        return completeWaitlistBooking({ classId, userId, studioId, repo, publisher, clock });
      }
      if (err instanceof BookingClosedError) {
        // ---- Step 5: class closed under the tx clock ----------
        return { code: err.result };
      }
      // ---- Step 6: transient / unexpected error -----------------
      throw err;
    }
  }

  // ---- Step 7: waitlist branch (DECR < 0, class is full) ----------
  await compensate(counter, logger, classId, 'counter_exhausted');

  return completeWaitlistBooking({ classId, userId, studioId, repo, publisher, clock });
}
