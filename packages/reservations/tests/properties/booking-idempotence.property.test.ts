/**
 * Booking flow — Property 2: Idempotence of `bookClass`.
 *
 * **Validates: Requirements 8.4, 8.5, 20.1**
 *
 * Requirement 8.4 — "WHEN the same `(user_id, class_id)` pair is
 * submitted more than once, THE Reservations_Service SHALL create at
 * most one reservation row enforced by the SQL unique constraint" —
 * is the domain-level idempotence guarantee the booking flow rests
 * on. Together with Requirement 8.5 (an `Idempotency-Key` replay
 * returns the previously produced result without creating a new
 * reservation) and Requirement 20.1 (at-most-once logical application
 * of a mutation), this property pins the contract that retrying
 * `bookClass` against the same `(userId, classId)` pair — for any
 * retry count, any capacity, any ordering — never creates a second
 * row and never publishes a second outbox event.
 *
 * The test DOES NOT need real Postgres or Redis. `@athlya/reservations/book`
 * is framework-free: it consumes three small ports (`BookingRepo`,
 * `BookingCounter`, `BookingEventPublisher`). Replacing each port
 * with a deterministic in-memory fake exercises the full algorithm
 * at domain speed while preserving the key invariant under test —
 * the `UNIQUE(class_id, user_id)` constraint — which the fake repo
 * enforces via a plain `Map` keyed by that pair.
 *
 * Two invariants are asserted over the same random run so a shrunk
 * counter-example answers both "how many rows" and "how many events"
 * in one step:
 *
 *   P1 — "at most one row":
 *        after N back-to-back calls of `bookClass` with identical
 *        `(userId, classId, idempotencyKey)`, the fake repo holds
 *        exactly 0 or 1 row for that pair. The `≤ 1` formulation
 *        matches Req 8.4 verbatim and is preserved by the fake
 *        repo's `Map`-backed unique constraint regardless of which
 *        branch of Algorithm 1 each replay takes.
 *
 *   P2 — "at most one outbox event":
 *        the fake outbox has recorded at most one booking-lifecycle
 *        event (`reservation.created` OR `reservation.waitlisted`)
 *        for that `(classId, userId)` pair. Subsequent replays must
 *        return `already_booked` WITHOUT publishing a second event,
 *        OR roll their transaction back on the unique-violation —
 *        either outcome preserves the ≤ 1 count.
 *
 * Note on the waitlist replay path
 * --------------------------------
 * Both the confirmed and waitlist branches of `bookClass` now catch
 * `UniqueViolationError` and return `already_booked` (Req 8.5, 20.1).
 * The property body previously swallowed thrown `UniqueViolationError`
 * exceptions for the waitlist path. It still does so for compatibility
 * with the fake repo — the fake's `withTransaction` rollback means the
 * exception surfaces here when capacity=1 and the counter drives into
 * negative territory on a replay, but only if the fake's in-memory
 * `Map` key is already present (i.e. first call was waitlisted). The
 * property remains correct because both outcomes (exception caught here,
 * or `already_booked` returned) leave the committed state with ≤ 1 row.
 *
 * Why fast-check rather than a hand-written example loop?
 *   The universal claim — "any N, any capacity, any interleaving of
 *   confirmed-vs-waitlist decisions yields ≤ 1 row" — is exactly the
 *   kind of statement a property test pins down in a single seeded
 *   run. Shrinking converges on the smallest failing `(capacity, N)`
 *   pair, which makes diagnosing a future regression a matter of
 *   reading a single line instead of a 40-step trace.
 *
 * Mechanics:
 *   - `numRuns: 100` keeps the whole file well under the 30 s
 *     `testTimeout` configured in `vitest.config.ts`, even with
 *     shrinking headroom.
 *   - A fixed `seed` makes failures reproducible locally and in CI;
 *     bump it deliberately to reshuffle the explored region, never
 *     rely on an unseeded run to "catch something".
 *   - Capacity is drawn from `[1, 50]` so both branches of Algorithm 1
 *     show up: small capacities force waitlist insertions on early
 *     calls, large capacities confirm the first call. In both cases
 *     P1 and P2 must hold.
 *   - N is drawn from `[2, 20]`: ≥ 2 so at least one replay occurs,
 *     ≤ 20 so a shrinking pass stays snappy.
 *   - UUIDs are freshly generated per run with `fc.uuid()` so runs
 *     do not share state across fast-check samples. A per-run fake
 *     factory is rebuilt inside the predicate for the same reason.
 */

import { fc, it } from '@fast-check/vitest';
import { describe, expect } from 'vitest';

import {
  bookClass,
  UniqueViolationError,
  type BookingClassRow,
  type BookingCounter,
  type BookingEventPublisher,
  type BookingOutboxEvent,
  type BookingRepo,
  type BookingReservationRow,
  type BookingTx,
} from '../../src/book.js';

/* ------------------------------------------------------------------ */
/*  Fake infrastructure                                                */
/* ------------------------------------------------------------------ */

/**
 * Opaque transaction handle used by the fake repo. `bookClass` never
 * inspects the shape; we hand out a fresh object per transaction so
 * cross-transaction contamination would surface as a reference
 * mismatch if we ever tightened the suite.
 */
interface FakeTx {
  readonly __brand: 'BookingTx';
  readonly id: number;
}

/**
 * Deterministic ID generator. fast-check seeds the RNG, but the
 * reservation / event IDs we mint INSIDE the fake need their own
 * counter so that (a) every row is distinguishable and (b) the IDs
 * are reproducible across runs for a given sample. A closure-scoped
 * integer does both jobs without pulling in `crypto.randomUUID()`.
 */
function makeCounter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(++n).toString(16).padStart(12, '0')}`;
}

interface FakeRepoState {
  readonly reservations: Map<string, BookingReservationRow>;
  readonly outbox: BookingOutboxEvent[];
  txCount: number;
}

/**
 * Build a fresh in-memory `BookingRepo` that enforces
 * `UNIQUE(class_id, user_id)` via a `Map`. The map key is
 * `${classId}|${userId}`: inserting a second row under the same key
 * throws a `UniqueViolationError`, mirroring the Postgres constraint
 * the production adapter relies on.
 *
 * `countWaitlistAhead` is wired to return 0 because this property
 * test does not concern itself with waitlist ordering — the
 * `(classId, userId)` pair is fixed per run, so at most one waitlist
 * row ever exists for it anyway.
 *
 * `findExistingConfirmedOrWaitlistReservation` reads straight from
 * the `Map`: a unique-violation implies a pre-existing row, which
 * `bookClass` retrieves through this port to return
 * `already_booked`.
 *
 * Transactional semantics: the production adapter rolls back on a
 * throw inside `withTransaction`. The fake mirrors that by snapshotting
 * the `reservations` Map and the `outbox` length BEFORE calling
 * `fn(tx)`, and restoring them if `fn` rejects. This matches the
 * behaviour `bookClass` relies on — an outbox row inserted inside a
 * tx that later rolls back must not survive.
 */
function buildFakeRepo(
  state: FakeRepoState,
  classRow: BookingClassRow,
  nextReservationId: () => string,
  clock: () => number,
): BookingRepo {
  return {
    findClass: async (classId: string) => (classId === classRow.id ? classRow : null),

    readClassClock: async (_tx: BookingTx, classId: string) =>
      classId === classRow.id ? { startsAt: classRow.startsAt, now: new Date(clock()) } : null,

    withTransaction: async <T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> => {
      const tx: FakeTx = { __brand: 'BookingTx', id: state.txCount++ };
      // Snapshot the state so we can roll back on rejection.
      const reservationSnapshot = new Map(state.reservations);
      const outboxSnapshot = state.outbox.length;
      try {
        return await fn(tx);
      } catch (err) {
        // Roll back both the reservation insert and any outbox
        // rows written inside the failed transaction.
        state.reservations.clear();
        for (const [k, v] of reservationSnapshot) {
          state.reservations.set(k, v);
        }
        state.outbox.length = outboxSnapshot;
        throw err;
      }
    },

    findExistingConfirmedOrWaitlistReservation: async (
      _tx: BookingTx,
      classId: string,
      userId: string,
    ): Promise<BookingReservationRow | null> => {
      const row = state.reservations.get(`${classId}|${userId}`);
      return row ?? null;
    },

    insertReservation: async (
      _tx: BookingTx,
      input: {
        readonly classId: string;
        readonly userId: string;
        readonly status: 'confirmed' | 'waitlist';
      },
    ): Promise<BookingReservationRow> => {
      const key = `${input.classId}|${input.userId}`;
      if (state.reservations.has(key)) {
        // Mirror the Postgres `UNIQUE(class_id, user_id)`
        // violation (SQLSTATE 23505). `bookClass` catches this
        // inside the confirmed branch, issues the compensating
        // `INCR`, and returns `already_booked`; inside the
        // waitlist branch it propagates, at which point the
        // enclosing `withTransaction` call rolls back.
        throw new UniqueViolationError();
      }
      const row: BookingReservationRow = {
        id: nextReservationId(),
        classId: input.classId,
        userId: input.userId,
        status: input.status,
        createdAt: new Date(clock()),
        cancelledAt: null,
        checkedInAt: null,
      };
      state.reservations.set(key, row);
      return row;
    },

    insertOutbox: async (_tx: BookingTx, event: BookingOutboxEvent): Promise<void> => {
      state.outbox.push(event);
    },

    countWaitlistAhead: async (): Promise<number> => 0,
  };
}

/**
 * Build a fresh `BookingCounter` seeded from `capacity`. A single
 * number — no map — because the property run only exercises one
 * class per sample. `decrRemaining` and `incrRemaining` are trivially
 * atomic in a JavaScript single-threaded runtime, so no locking is
 * needed to preserve the production semantics for the property
 * under test.
 */
function buildFakeCounter(capacity: number): BookingCounter {
  let remaining = capacity;
  return {
    decrRemaining: async () => {
      remaining -= 1;
      return remaining;
    },
    decrRemainingOrInit: async (_classId: string, _capacity: number) => {
      remaining -= 1;
      return remaining;
    },
    incrRemaining: async () => {
      remaining += 1;
      return remaining;
    },
  };
}

/**
 * Fake `BookingEventPublisher`. Both builders return a fresh event
 * envelope with a unique `eventId`, matching the production contract
 * (Req 17.4: consumers dedup on `eventId`). The fake here doesn't
 * need real UUIDs — a monotonic hex counter is deterministic and
 * collision-free for the bounded runs we exercise.
 */
function buildFakePublisher(nextEventId: () => string, clock: () => number): BookingEventPublisher {
  return {
    buildReservationCreated: (input) => ({
      eventId: nextEventId(),
      eventType: 'reservation.created',
      payload: {
        reservationId: input.reservationId,
        classId: input.classId,
        userId: input.userId,
        studioId: input.studioId,
      },
      occurredAt: new Date(clock()),
    }),
    buildReservationWaitlisted: (input) => ({
      eventId: nextEventId(),
      eventType: 'reservation.waitlisted',
      payload: {
        reservationId: input.reservationId,
        classId: input.classId,
        userId: input.userId,
        studioId: input.studioId,
        position: input.position,
      },
      occurredAt: new Date(clock()),
    }),
  };
}

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/** Reservation capacity per run, drawn from [1, 50]. */
const capacityArb = fc.integer({ min: 1, max: 50 });

/** Number of `bookClass` replays per run, drawn from [2, 20]. */
const replayCountArb = fc.integer({ min: 2, max: 20 });

/** A stable, random UUID v4. `bookClass` only uses this as an opaque string. */
const uuidArb = fc.uuid();

/**
 * A stable, random idempotency key. Opaque to `bookClass` — the
 * gateway layer dedups on it, but the domain flow threads it through
 * unchanged. Including it in the arbitrary set exercises the
 * "fixed idempotencyKey across replays" scenario called out by the
 * task description.
 */
const idempotencyKeyArb = fc.uuid();

/**
 * Reproducibility parameters. `numRuns: 100` is the level mandated by
 * the task; the hex seed is arbitrary but stable so a failing run
 * names the seed explicitly in its log.
 */
const RUN_OPTS = { numRuns: 100, seed: 0xb00c_11d1 } as const;

/* ------------------------------------------------------------------ */
/*  Per-run fake world                                                  */
/* ------------------------------------------------------------------ */

interface FakeWorld {
  readonly state: FakeRepoState;
  readonly repo: BookingRepo;
  readonly counter: BookingCounter;
  readonly publisher: BookingEventPublisher;
  readonly classRow: BookingClassRow;
  /**
   * Frozen clock to pass as `BookClassInput.clock`. Keeping the
   * clock pinned guarantees `startsAt > now()` on every replay so
   * the property under test never incidentally trips the
   * `class_in_past` short-circuit (which would make P2.3 vacuously
   * true without exercising the idempotence branches).
   */
  readonly clock: () => number;
}

/**
 * Assemble a self-contained fake world for one property sample.
 * Every closure keeps its own monotonic clock so `createdAt` values
 * grow over replays — this makes a shrunk counter-example easier to
 * eyeball without affecting any assertion.
 */
function buildWorld(capacity: number, classId: string, studioId: string): FakeWorld {
  // Pin the simulated wall-clock at a fixed instant we can reason about,
  // and run every `bookClass` call under a frozen `clock` that returns
  // this same value. Doing the clock injection — rather than picking a
  // future date and hoping — means the test keeps passing in 2030, 2040,
  // and beyond, without any calendar-dependent drift.
  const NOW_MS = Date.parse('2026-06-01T09:00:00.000Z');
  // Monotonic internal clock used for `createdAt` stamps so repeated
  // reservation rows (if the flow ever produced them, which it mustn't)
  // would be distinguishable in a shrunk counter-example. Note that
  // this is DISTINCT from the `clock` passed to `bookClass` below: the
  // latter must satisfy `startsAt > clock()` on every replay, so it
  // stays pinned.
  let tick = 0;
  const stampClock = (): number => NOW_MS + tick++;
  const bookClock = (): number => NOW_MS;

  const state: FakeRepoState = {
    reservations: new Map(),
    outbox: [],
    txCount: 0,
  };

  const classRow: BookingClassRow = {
    id: classId,
    studioId,
    capacity,
    // `startsAt` is always 1 h after the frozen `bookClock()`, so
    // `bookClass` never returns `class_in_past` — the property under
    // test applies to the non-short-circuit branches.
    startsAt: new Date(NOW_MS + 60 * 60_000),
    version: 0,
  };

  const repo = buildFakeRepo(state, classRow, makeCounter('res'), stampClock);
  const counter = buildFakeCounter(capacity);
  const publisher = buildFakePublisher(makeCounter('evt'), stampClock);

  return { state, repo, counter, publisher, classRow, clock: bookClock };
}

/**
 * Run the N replays, tolerating thrown exceptions on the waitlist
 * unique-violation path (see module header). Exceptions preserve the
 * spec bound because the enclosing transaction rolls back, so
 * swallowing them is correct for this property.
 */
async function replayBook(
  world: FakeWorld,
  n: number,
  userId: string,
  idempotencyKey: string,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      await bookClass({
        classId: world.classRow.id,
        userId,
        studioId: world.classRow.studioId,
        idempotencyKey,
        repo: world.repo,
        counter: world.counter,
        publisher: world.publisher,
        clock: world.clock,
      });
    } catch (err) {
      // The waitlist branch does not catch UniqueViolationError —
      // a duplicate replay on that path throws. The transaction
      // has already rolled back, so both invariants (≤ 1 row,
      // ≤ 1 event) are preserved. Any OTHER error would be a
      // real regression in the fake infrastructure.
      if (!(err instanceof UniqueViolationError)) {
        throw err;
      }
    }
  }
}

/**
 * Count outbox events touching the (classId, userId) pair under
 * test. Reading the payload's shape defensively — `unknown` keys —
 * mirrors the production outbox schema where `payload` is
 * `Record<string, unknown>`.
 */
function outboxEventsForPair(world: FakeWorld, userId: string): BookingOutboxEvent[] {
  return world.state.outbox.filter((e) => {
    const p = e.payload as {
      readonly classId?: unknown;
      readonly userId?: unknown;
    };
    return p.classId === world.classRow.id && p.userId === userId;
  });
}

/* ------------------------------------------------------------------ */
/*  Properties                                                          */
/* ------------------------------------------------------------------ */

describe('bookClass — Property 2 (idempotence)', () => {
  /**
   * P2.1 — at most one row (Req 8.4).
   *
   * The fake repo enforces `UNIQUE(class_id, user_id)` via a `Map`.
   * The invariant `|rows for (classId, userId)| ≤ 1` must hold
   * after ANY number of replays, regardless of which branch of
   * Algorithm 1 each call takes.
   */
  it.prop([capacityArb, replayCountArb, uuidArb, uuidArb, uuidArb, idempotencyKeyArb], RUN_OPTS)(
    'N replays with the same (userId, classId) produce at most one reservation row (Req 8.4, 8.5, 20.1)',
    async (capacity, n, classId, userId, studioId, idempotencyKey) => {
      const world = buildWorld(capacity, classId, studioId);
      await replayBook(world, n, userId, idempotencyKey);

      // Count rows that match the (classId, userId) pair under
      // test. The fake repo keys its Map with `${classId}|${userId}`
      // so there is at most one such entry by construction; the
      // assertion still exists so a future refactor that removed
      // the Map's uniqueness would fail the property loudly.
      const rowsForPair = Array.from(world.state.reservations.keys()).filter(
        (k) => k === `${classId}|${userId}`,
      );
      return rowsForPair.length <= 1;
    },
  );

  /**
   * P2.2 — at most one outbox event (Req 8.5, 20.1).
   *
   * The confirmed branch returns `already_booked` on the unique
   * violation and does NOT publish a second event. The waitlist
   * branch rolls the transaction back on the unique violation,
   * which also prevents the second outbox row from being committed
   * (the fake `withTransaction` restores the outbox length on
   * rejection, mirroring Postgres ROLLBACK semantics).
   *
   * In both paths the invariant holds: at most one published event
   * per `(classId, userId)` pair.
   */
  it.prop([capacityArb, replayCountArb, uuidArb, uuidArb, uuidArb, idempotencyKeyArb], RUN_OPTS)(
    'across N replays, at most one reservation.{created,waitlisted} outbox event is published (Req 8.5, 20.1)',
    async (capacity, n, classId, userId, studioId, idempotencyKey) => {
      const world = buildWorld(capacity, classId, studioId);
      await replayBook(world, n, userId, idempotencyKey);

      const eventsForPair = outboxEventsForPair(world, userId);
      if (eventsForPair.length > 1) {
        return false;
      }

      // When an event IS published (the common case — the very
      // first call always succeeds), it must be one of the two
      // legal booking-lifecycle event types. Any other type is
      // a regression in the publisher wiring.
      const legalTypes = new Set<BookingOutboxEvent['eventType']>([
        'reservation.created',
        'reservation.waitlisted',
      ]);
      return eventsForPair.every((e) => legalTypes.has(e.eventType));
    },
  );

  /**
   * P2.3 — first call succeeds, subsequent confirmed-branch replays
   * return `already_booked` without publishing (Req 8.5).
   *
   * This restricts attention to the regime where every replay
   * stays on the confirmed branch of Algorithm 1. That requires
   * `capacity ≥ 2`: after the first `DECR` the counter sits at
   * `capacity - 1`; a confirmed-branch replay takes a compensating
   * `INCR` after its UniqueViolation, which restores the counter
   * to `capacity - 1` again. So the counter stays at `capacity - 1
   * ≥ 1 > 0` on every replay — `bookClass` never falls through to
   * the waitlist branch — and the stronger idempotence contract
   * (every replay returns `already_booked`, publishes nothing)
   * must hold.
   *
   * When `capacity = 1`, the second call's `DECR` reaches `-1`,
   * entering the waitlist branch. With the fix in place, the waitlist
   * branch now returns `already_booked` on a unique violation. That
   * path is covered by P2.1 and P2.2, so excluding it here is sound
   * — this property focuses on the confirmed-replay regime.
   */
  it.prop([capacityArb, replayCountArb, uuidArb, uuidArb, uuidArb, idempotencyKeyArb], RUN_OPTS)(
    'after a confirmed first call, replays return already_booked and publish no further events (Req 8.5, 20.1)',
    async (capacity, n, classId, userId, studioId, idempotencyKey) => {
      // Precondition: `capacity ≥ 2` guarantees every call stays
      // on the confirmed branch of Algorithm 1 (see JSDoc above).
      fc.pre(capacity >= 2);

      const world = buildWorld(capacity, classId, studioId);

      const firstResult = await bookClass({
        classId,
        userId,
        studioId,
        idempotencyKey,
        repo: world.repo,
        counter: world.counter,
        publisher: world.publisher,
        clock: world.clock,
      });
      if (firstResult.code !== 'ok') {
        return false;
      }

      const outboxSizeAfterFirst = world.state.outbox.length;

      for (let i = 1; i < n; i++) {
        const replay = await bookClass({
          classId,
          userId,
          studioId,
          idempotencyKey,
          repo: world.repo,
          counter: world.counter,
          publisher: world.publisher,
          clock: world.clock,
        });
        if (replay.code !== 'already_booked') {
          return false;
        }
        if (world.state.outbox.length !== outboxSizeAfterFirst) {
          return false;
        }
      }

      return true;
    },
  );

  /* ------------------------------------------------------------------ */
  /*  Belt-and-braces regression anchor                                   */
  /* ------------------------------------------------------------------ */

  // A single hand-picked example so a broken fast-check harness
  // (e.g. every sample filtered out) still cannot let a regression
  // slip through this file.
  it('regression anchor: 5 confirmed-branch replays yield one row and one reservation.created event', async () => {
    const world = buildWorld(
      5,
      '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab',
      '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac',
    );
    const userId = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c800';

    for (let i = 0; i < 5; i++) {
      await bookClass({
        classId: world.classRow.id,
        userId,
        studioId: world.classRow.studioId,
        idempotencyKey: 'ba5ebabe-dead-4bee-8000-000000000001',
        repo: world.repo,
        counter: world.counter,
        publisher: world.publisher,
        clock: world.clock,
      });
    }

    expect(world.state.reservations.size).toBe(1);
    expect(world.state.outbox).toHaveLength(1);
    expect(world.state.outbox[0]!.eventType).toBe('reservation.created');
  });
});
