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
 *   2. Postgres transaction — `BEGIN`, `SELECT FOR UPDATE` on the
 *      `classes` row, `INSERT` the reservation row (protected by the
 *      `UNIQUE(class_id, user_id)` constraint), `INSERT` the outbox
 *      event row, `COMMIT`. The unique constraint is the last-line
 *      defence against double-booking even under Redis loss of
 *      atomicity or replay.
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
 * critical path in the codebase. A wrong `tx` passed to
 * `BookingRepo.lockClass` would silently bypass the SELECT FOR
 * UPDATE and reintroduce the double-booking race the algorithm
 * exists to prevent. The brand is a structural guard.
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
   * Implementations SHOULD accept rows in any status; the booking
   * flow treats a `cancelled` row as "user re-booked after
   * cancellation" which is a legitimate success and returns the
   * existing row unchanged.
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
   * `UNIQUE(class_id, user_id)` collision.
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
   * Count waitlisted rows whose `created_at` is strictly earlier
   * than `reservationCreatedAt` for the given class. Used to
   * compute the 1-based position returned with the `waitlisted`
   * result: `position = countWaitlistAhead(...) + 1`.
   *
   * SHOULD match the SQL
   * `SELECT COUNT(*) FROM reservations
   *    WHERE class_id = $1
   *      AND status = 'waitlist'
   *      AND created_at < $2`.
   */
  countWaitlistAhead(tx: BookingTx, classId: string, reservationCreatedAt: Date): Promise<number>;
}

/**
 * Redis seat-counter port. Matches the relevant slice of
 * {@link RemainingCounter} from `./counter.ts` — declared locally so
 * the port name stays semantically meaningful (`decrRemaining` /
 * `incrRemaining`) and so tests can wire the two methods without
 * pulling the full interface.
 */
export interface BookingCounter {
  /** Atomically decrement `class:{classId}:remaining`; return the new value (may be negative). */
  decrRemaining(classId: string): Promise<number>;
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
  /** Defaults to `Date.now`. Supplied explicitly in tests. */
  readonly clock?: BookClock;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Book a class following Algorithm 1.
 *
 * Control flow (numbered to match the pseudo-code in `design.md`):
 *
 *   0. Pre-flight: load the class row. Short-circuit with
 *      `class_not_found` on `null` and `class_in_past` on
 *      `startsAt ≤ now()`. BOTH checks run BEFORE any Redis traffic
 *      so a malformed or cross-tenant request never perturbs the
 *      counter (no compensating INCR needed on these paths).
 *
 *   1. Redis `DECR` on `class:{classId}:remaining`. This is the
 *      atomic claim primitive.
 *
 *   2. If `DECR ≥ 0`: attempt the confirmed-booking transaction.
 *      Inside the tx:
 *         - `insertReservation(status='confirmed')` — the unique
 *           constraint on `(class_id, user_id)` is the ultimate
 *           safeguard against double-booking.
 *         - `insertOutbox(reservation.created)` — publishes on
 *           commit (Req 16.1). The drain worker picks up the row
 *           within 30 s (Req 16.4).
 *      Commit returns `{ code: 'ok' }` with the inserted row and
 *      the `remaining` value seen from the DECR.
 *
 *   3. If the tx throws a {@link ClassCapacityExceededError}: the
 *      Redis counter was optimistic — compensate with INCR and fall
 *      through to the waitlist branch (PostgreSQL is authoritative).
 *   4. If the tx throws a {@link UniqueViolationError}: the user
 *      already holds a row. Compensating `INCR` (we over-claimed)
 *      and return the existing row as `already_booked`. No second
 *      outbox event.
 *   5. If the tx throws anything else: compensating `INCR` and
 *      rethrow. The API gateway's handler turns this into a 5xx.
 *
 *   6. If `DECR < 0`: compensating `INCR` (we didn't actually
 *      consume a seat — the value was already at 0 or below), then
 *      enter the waitlist branch. A fresh transaction inserts with
 *      `status='waitlist'`, computes the 1-based position from
 *      `countWaitlistAhead`, and publishes `reservation.waitlisted`.
 *
 * **Invariant preserved** (Req 8.3): for every class `c`,
 * `count(reservations WHERE class_id = c AND status = 'confirmed')
 *  ≤ c.capacity` at every externally-observable instant. The proof
 * rests on the two-step protocol: Redis enforces the capacity cap
 * across concurrent contenders, and the unique SQL index enforces
 * the idempotence cap across retries of the same user.
 *
 * **Idempotence** (Req 8.4, 8.5): replaying `bookClass` with the same
 * `(userId, classId)` yields `already_booked` on the second call.
 * Combined with the gateway's `Idempotency-Key` dedup layer this
 * guarantees at-most-once logical booking even under arbitrarily
 * aggressive retries.
 */
async function completeWaitlistBooking(input: {
  readonly classId: string;
  readonly userId: string;
  readonly studioId: string;
  readonly repo: BookingRepo;
  readonly publisher: BookingEventPublisher;
}): Promise<Extract<BookResult, { code: 'waitlisted' | 'already_booked' }>> {
  const { classId, userId, studioId, repo, publisher } = input;

  try {
    const { reservation: waitlisted, position } = await repo.withTransaction(async (tx) => {
      const row = await repo.insertReservation(tx, {
        classId,
        userId,
        status: 'waitlist',
      });
      const ahead = await repo.countWaitlistAhead(tx, classId, row.createdAt);
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
    if (isUniqueViolation(err)) {
      // The user already holds a waitlist row (double-tap / retry).
      // The transaction rolled back so no second outbox event is committed.
      // Fetch the existing row and return already_booked — same idempotence
      // contract as the confirmed branch.
      const existing = await repo.withTransaction((tx) =>
        repo.findExistingConfirmedOrWaitlistReservation(tx, classId, userId),
      );
      if (existing === null) {
        throw new Error(
          `bookClass: unique-violation on waitlist (${classId}, ${userId}) but no existing reservation found`,
        );
      }
      return { code: 'already_booked', reservation: existing };
    }
    throw err;
  }
}

export async function bookClass(input: BookClassInput): Promise<BookResult> {
  const { classId, userId, studioId, repo, counter, publisher } = input;
  const now = (input.clock ?? Date.now)();

  // ---- Step 0: pre-flight (cheap, idempotent, no side-effects) ------
  //
  // We look up the class BEFORE touching Redis so:
  //   - a `null` row (unknown id / wrong tenant under RLS) surfaces
  //     as `class_not_found` with zero compensating work;
  //   - a class whose `startsAt ≤ now()` surfaces as `class_in_past`
  //     (Req 8.6) without perturbing the counter.
  // Both short-circuits preserve the global capacity invariant.
  const classRow = await repo.findClass(classId);
  if (classRow === null) {
    return { code: 'class_not_found' };
  }
  if (classRow.startsAt.getTime() <= now) {
    return { code: 'class_in_past' };
  }

  // ---- Step 1: atomic "claim a seat" primitive (Req 8.3) -----------
  //
  // Redis DECR returns the new value. A non-negative value means we
  // have a provisional claim; we still need the SQL transaction to
  // turn it into a durable reservation. A negative value means the
  // counter was already exhausted — fall through to the waitlist
  // branch.
  //
  // If Redis is unavailable we fail-closed: the booking is rejected
  // with counter_unavailable so the client gets a retryable 503
  // rather than an opaque 5xx, and the capacity invariant is preserved.
  let remaining: number;
  try {
    remaining = await counter.decrRemaining(classId);
  } catch {
    return { code: 'counter_unavailable' };
  }

  if (remaining >= 0) {
    // ---- Step 2: confirmed-booking transaction --------------------
    //
    // We cannot `return await` straight from inside the try block
    // without shadowing the catch below, so we stash the result in
    // a local and dispatch on it after the catch.
    try {
      const confirmed = await repo.withTransaction(async (tx) => {
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
      if (isUniqueViolation(err)) {
        // ---- Step 3: idempotent replay ------------------------
        //
        // The user already holds a row for this class. Undo our
        // DECR (we optimistically claimed a seat we don't need)
        // and return the existing reservation. No second event.
        await counter.incrRemaining(classId);
        const existing = await repo.withTransaction((tx) =>
          repo.findExistingConfirmedOrWaitlistReservation(tx, classId, userId),
        );
        if (existing === null) {
          // Invariant broken: a unique-violation means there
          // MUST be a pre-existing row. If the lookup comes
          // back empty something external deleted it between
          // the INSERT attempt and this SELECT — rethrow as
          // a generic error so the gateway returns 5xx.
          throw new Error(
            `bookClass: unique-violation on (${classId}, ${userId}) but no existing reservation found`,
          );
        }
        return { code: 'already_booked', reservation: existing };
      }

      if (isClassCapacityExceeded(err)) {
        await counter.incrRemaining(classId);
        return completeWaitlistBooking({ classId, userId, studioId, repo, publisher });
      }

      // ---- Step 4: transient / unexpected error ------------------
      //
      // Any OTHER failure (DB outage, RLS rejection on insert,
      // deadlock, etc.) leaves us holding a phantom DECR. Restore
      // the counter and rethrow so the API gateway can map this
      // to a 5xx Problem Details envelope.
      await counter.incrRemaining(classId);
      throw err;
    }
  }

  // ---- Step 5: waitlist branch (DECR < 0, class is full) ----------
  //
  // The counter was already at 0 or lower when we came in. The DECR
  // drove it further negative; we compensate with an INCR so the
  // counter reflects reality again (the counter is only meaningful
  // as long as it is ≥ 0; the service's own reads clamp it via
  // Math.max(0, …)).
  await counter.incrRemaining(classId);

  return completeWaitlistBooking({ classId, userId, studioId, repo, publisher });
}
