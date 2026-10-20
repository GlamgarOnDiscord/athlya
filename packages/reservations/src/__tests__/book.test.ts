/**
 * Unit tests for `@athlya/reservations/book`.
 *
 * Exercises Algorithm 1 (the two-phase Redis + Postgres booking
 * protocol) end-to-end over `vi.fn()` doubles. The suite covers
 * every branch named in task 6.4 of the Athlya implementation plan:
 *
 *   - Happy path (DECR ≥ 0) → counter decremented, row inserted,
 *     `reservation.created` outbox insert, result `{ code: 'ok' }`.
 *   - Capacity exhausted (DECR < 0) → compensating INCR, waitlist
 *     insert, `reservation.waitlisted` outbox insert, result
 *     `{ code: 'waitlisted' }` with the correct 1-based position.
 *   - `UniqueViolation` on the confirmed INSERT → compensating INCR,
 *     existing reservation fetched, result
 *     `{ code: 'already_booked' }`, no duplicate outbox.
 *   - `class.startsAt ≤ now()` → `{ code: 'class_in_past' }`, no
 *     Redis traffic (the counter must NOT be touched here; a
 *     malformed request never perturbs the seat counter).
 *   - Class not found → `{ code: 'class_not_found' }`.
 *   - Arbitrary error inside the tx → compensating INCR and the
 *     error is re-thrown.
 *
 * No real DB, no real Redis — every port is a `vi.fn()` double so
 * the whole file runs in < 50 ms and fails fast on shape drift.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  bookClass,
  ClassCapacityExceededError,
  UniqueViolationError,
  type BookClassInput,
  type BookingClassRow,
  type BookingCounter,
  type BookingEventPublisher,
  type BookingOutboxEvent,
  type BookingRepo,
  type BookingReservationRow,
  type BookingTx,
} from '../book.js';

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c800';
const RESERVATION_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c810';
const EVENT_ID_CREATED = 'e0000000-0000-4000-8000-000000000001';
const EVENT_ID_WAITLISTED = 'e0000000-0000-4000-8000-000000000002';

/** Frozen wall-clock so `startsAt` comparisons are deterministic. */
const FROZEN_NOW = Date.parse('2026-02-03T06:30:00.000Z');

/** A class scheduled well after `FROZEN_NOW`. */
const FUTURE_CLASS: BookingClassRow = {
  id: CLASS_ID,
  studioId: STUDIO_ID,
  capacity: 20,
  startsAt: new Date(FROZEN_NOW + 60 * 60_000),
  version: 0,
};

/** Canonical confirmed reservation returned by the repo on insert. */
const CONFIRMED_ROW: ReservationRow = {
  id: RESERVATION_ID,
  classId: CLASS_ID,
  userId: USER_ID,
  status: 'confirmed',
  createdAt: new Date(FROZEN_NOW),
  cancelledAt: null,
  checkedInAt: null,
};

/** Canonical waitlisted reservation returned by the repo on insert. */
const WAITLIST_ROW: ReservationRow = {
  id: RESERVATION_ID,
  classId: CLASS_ID,
  userId: USER_ID,
  status: 'waitlist',
  createdAt: new Date(FROZEN_NOW),
  cancelledAt: null,
  checkedInAt: null,
};

/**
 * Canned envelopes the fake publisher hands back. Tests use them to
 * assert the outbox layer receives exactly the envelope built by the
 * publisher — no silent reshaping in the book flow.
 */
const CREATED_EVENT: BookingOutboxEvent = {
  eventId: EVENT_ID_CREATED,
  eventType: 'reservation.created',
  payload: {
    reservationId: RESERVATION_ID,
    classId: CLASS_ID,
    userId: USER_ID,
  },
  occurredAt: new Date(FROZEN_NOW),
};

const WAITLISTED_EVENT_POS_1: BookingOutboxEvent = {
  eventId: EVENT_ID_WAITLISTED,
  eventType: 'reservation.waitlisted',
  payload: {
    reservationId: RESERVATION_ID,
    classId: CLASS_ID,
    userId: USER_ID,
    position: 1,
  },
  occurredAt: new Date(FROZEN_NOW),
};

/* ------------------------------------------------------------------ */
/*  Port builders                                                      */
/* ------------------------------------------------------------------ */

/**
 * Non-generic sibling of `BookingRepo['withTransaction']`. Vitest's
 * `Mock<>` helper cannot express a generic signature, so the suite
 * types the double as the monomorphic `(fn) => Promise<unknown>`
 * variant and re-cast to the generic contract when assembling the
 * `BookingRepo`. The runtime behaviour is identical — `fn(tx)` simply
 * returns whatever the caller's async arrow resolves with.
 */
type WithTransactionMonomorphic = (fn: (tx: BookingTx) => Promise<unknown>) => Promise<unknown>;

interface Doubles {
  deps: Omit<BookClassInput, 'classId' | 'userId' | 'studioId'>;
  findClass: Mock<BookingRepo['findClass']>;
  withTransaction: Mock<WithTransactionMonomorphic>;
  findExisting: Mock<BookingRepo['findExistingConfirmedOrWaitlistReservation']>;
  insertReservation: Mock<BookingRepo['insertReservation']>;
  insertOutbox: Mock<BookingRepo['insertOutbox']>;
  countWaitlistAhead: Mock<BookingRepo['countWaitlistAhead']>;
  readClassClock: Mock<BookingRepo['readClassClock']>;
  lockClassForBooking: Mock<BookingRepo['lockClassForBooking']>;
  findOwnHold: Mock<BookingRepo['findOwnHold']>;
  confirmHold: Mock<BookingRepo['confirmHold']>;
  releaseHold: Mock<BookingRepo['releaseHold']>;
  decrRemaining: Mock<BookingCounter['decrRemaining']>;
  decrRemainingOrInit: Mock<BookingCounter['decrRemainingOrInit']>;
  incrRemaining: Mock<BookingCounter['incrRemaining']>;
  buildCreated: Mock<BookingEventPublisher['buildReservationCreated']>;
  buildWaitlisted: Mock<BookingEventPublisher['buildReservationWaitlisted']>;
  /** Captures every tx handle passed to the repo ports. */
  txSeen: BookingTx[];
}

/**
 * Build a fresh set of port doubles. `withTransaction` executes the
 * callback synchronously-on-the-microtask with a distinct sentinel
 * `tx` value so every SQL port can be asserted to have run inside
 * the transaction boundary.
 */
function buildDoubles(): Doubles {
  const findClass = vi.fn<BookingRepo['findClass']>();
  const findExisting = vi.fn<BookingRepo['findExistingConfirmedOrWaitlistReservation']>();
  const insertReservation = vi.fn<BookingRepo['insertReservation']>();
  const insertOutbox = vi.fn<BookingRepo['insertOutbox']>();
  const countWaitlistAhead = vi.fn<BookingRepo['countWaitlistAhead']>();
  // The in-transaction re-check sees the class still in the future by
  // default; individual tests override it.
  const readClassClock = vi
    .fn<BookingRepo['readClassClock']>()
    .mockResolvedValue({ startsAt: FUTURE_CLASS.startsAt, now: new Date(FROZEN_NOW) });
  const lockClassForBooking = vi.fn<BookingRepo['lockClassForBooking']>().mockResolvedValue({
    startsAt: FUTURE_CLASS.startsAt,
    now: new Date(FROZEN_NOW),
    version: FUTURE_CLASS.version,
  });
  // No seat hold unless a test seeds one.
  const findOwnHold = vi.fn<BookingRepo['findOwnHold']>().mockResolvedValue(null);
  const confirmHold = vi.fn<BookingRepo['confirmHold']>();
  const releaseHold = vi.fn<BookingRepo['releaseHold']>().mockResolvedValue(undefined);

  const txSeen: BookingTx[] = [];
  const withTransaction = vi.fn<WithTransactionMonomorphic>(async (fn) => {
    // Fresh opaque sentinel per transaction so the suite can
    // detect accidental cross-tx contamination.
    const tx: BookingTx = { __brand: 'BookingTx' };
    txSeen.push(tx);
    return fn(tx);
  });

  const decrRemaining = vi.fn<BookingCounter['decrRemaining']>();
  const decrRemainingOrInit = vi.fn<BookingCounter['decrRemainingOrInit']>();
  const incrRemaining = vi
    .fn<BookingCounter['incrRemaining']>()
    // `incrRemaining` is called for compensating actions only; the
    // return value isn't inspected by the flow, so resolve with 0
    // by default.
    .mockResolvedValue(0);

  const buildCreated = vi
    .fn<BookingEventPublisher['buildReservationCreated']>()
    .mockReturnValue(CREATED_EVENT);
  const buildWaitlisted = vi
    .fn<BookingEventPublisher['buildReservationWaitlisted']>()
    .mockReturnValue(WAITLISTED_EVENT_POS_1);

  const repo: BookingRepo = {
    findClass,
    // Cast back to the generic signature: the runtime is
    // type-erasing, `fn(tx)` doesn't care about `T` at all.
    withTransaction: withTransaction as unknown as BookingRepo['withTransaction'],
    findExistingConfirmedOrWaitlistReservation: findExisting,
    insertReservation,
    insertOutbox,
    countWaitlistAhead,
    readClassClock,
    lockClassForBooking,
    findOwnHold,
    confirmHold,
    releaseHold,
  };
  const counter: BookingCounter = { decrRemaining, decrRemainingOrInit, incrRemaining };
  const publisher: BookingEventPublisher = {
    buildReservationCreated: buildCreated,
    buildReservationWaitlisted: buildWaitlisted,
  };

  return {
    deps: { repo, counter, publisher, clock: () => FROZEN_NOW },
    findClass,
    withTransaction,
    findExisting,
    insertReservation,
    insertOutbox,
    countWaitlistAhead,
    readClassClock,
    lockClassForBooking,
    findOwnHold,
    confirmHold,
    releaseHold,
    decrRemaining,
    decrRemainingOrInit,
    incrRemaining,
    buildCreated,
    buildWaitlisted,
    txSeen,
  };
}

/** Convenience invocation with the default class/user/studio IDs. */
function invoke(
  deps: Doubles['deps'],
  overrides: Partial<Pick<BookClassInput, 'classId' | 'userId' | 'studioId'>> = {},
): Promise<Awaited<ReturnType<typeof bookClass>>> {
  return bookClass({
    classId: overrides.classId ?? CLASS_ID,
    userId: overrides.userId ?? USER_ID,
    studioId: overrides.studioId ?? STUDIO_ID,
    ...deps,
  });
}

/* ------------------------------------------------------------------ */
/*  Happy path — Req 8.1                                               */
/* ------------------------------------------------------------------ */

describe('bookClass — happy path (confirmed booking)', () => {
  it('decrements the counter, inserts a confirmed row, publishes reservation.created, returns ok', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    // DECR returns a non-negative value → we successfully claimed
    // a seat.
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.insertReservation.mockResolvedValueOnce(CONFIRMED_ROW);
    d.insertOutbox.mockResolvedValueOnce(undefined);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'ok',
      reservation: CONFIRMED_ROW,
      remaining: 5,
    });

    // decrRemainingOrInit runs exactly once with the class capacity;
    // no compensating INCR on the happy path.
    expect(d.decrRemainingOrInit).toHaveBeenCalledExactlyOnceWith(CLASS_ID, FUTURE_CLASS.capacity);
    expect(d.incrRemaining).not.toHaveBeenCalled();

    // The INSERT runs inside the transaction started by
    // withTransaction.
    expect(d.withTransaction).toHaveBeenCalledOnce();
    expect(d.insertReservation).toHaveBeenCalledExactlyOnceWith(d.txSeen[0], {
      classId: CLASS_ID,
      userId: USER_ID,
      status: 'confirmed',
    });

    // The publisher builds the event envelope and the repo writes
    // it to the outbox — strictly within the same tx.
    expect(d.buildCreated).toHaveBeenCalledExactlyOnceWith({
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
    });
    expect(d.insertOutbox).toHaveBeenCalledExactlyOnceWith(d.txSeen[0], CREATED_EVENT);

    // No waitlist-side activity on the happy path.
    expect(d.countWaitlistAhead).not.toHaveBeenCalled();
    expect(d.buildWaitlisted).not.toHaveBeenCalled();
    expect(d.findExisting).not.toHaveBeenCalled();
  });

  it('runs DECR BEFORE insertReservation and insertOutbox BEFORE the tx commit', async () => {
    const d = buildDoubles();
    const order: string[] = [];

    d.findClass.mockImplementationOnce(() => {
      order.push('findClass');
      return Promise.resolve(FUTURE_CLASS);
    });
    d.decrRemainingOrInit.mockImplementationOnce(() => {
      order.push('decr');
      return Promise.resolve(0);
    });
    d.insertReservation.mockImplementationOnce(() => {
      order.push('insertReservation');
      return Promise.resolve(CONFIRMED_ROW);
    });
    d.insertOutbox.mockImplementationOnce(() => {
      order.push('insertOutbox');
      return Promise.resolve();
    });

    await invoke(d.deps);

    expect(order).toStrictEqual(['findClass', 'decr', 'insertReservation', 'insertOutbox']);
  });
});

/* ------------------------------------------------------------------ */
/*  Waitlist — Req 8.2                                                  */
/* ------------------------------------------------------------------ */

describe('bookClass — waitlist branch (DECR < 0)', () => {
  it('compensates with INCR, inserts a waitlist row, publishes reservation.waitlisted, returns waitlisted', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    // DECR returned a negative value → class is full.
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    d.insertReservation.mockResolvedValueOnce(WAITLIST_ROW);
    // 2 people ahead → our position is 3.
    d.countWaitlistAhead.mockResolvedValueOnce(2);
    d.buildWaitlisted.mockReturnValueOnce({
      ...WAITLISTED_EVENT_POS_1,
      payload: {
        ...WAITLISTED_EVENT_POS_1.payload,
        position: 3,
      },
    });
    d.insertOutbox.mockResolvedValueOnce(undefined);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'waitlisted',
      reservation: WAITLIST_ROW,
      position: 3,
    });

    // Compensating INCR was issued to neutralise the DECR that
    // drove the counter into negative territory.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);

    // Row inserted with status='waitlist' inside the tx.
    expect(d.insertReservation).toHaveBeenCalledExactlyOnceWith(d.txSeen[0], {
      classId: CLASS_ID,
      userId: USER_ID,
      status: 'waitlist',
    });

    // Position computed from countWaitlistAhead + 1.
    expect(d.countWaitlistAhead).toHaveBeenCalledExactlyOnceWith(d.txSeen[0], CLASS_ID, {
      id: WAITLIST_ROW.id,
      createdAt: WAITLIST_ROW.createdAt,
    });
    expect(d.buildWaitlisted).toHaveBeenCalledExactlyOnceWith({
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      position: 3,
    });

    // No confirmed-event path was taken.
    expect(d.buildCreated).not.toHaveBeenCalled();
    expect(d.insertOutbox).toHaveBeenCalledOnce();
  });

  it('returns position = 1 when the waitlist is empty', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    d.insertReservation.mockResolvedValueOnce(WAITLIST_ROW);
    d.countWaitlistAhead.mockResolvedValueOnce(0);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'waitlisted',
      reservation: WAITLIST_ROW,
      position: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  UniqueViolation — Req 8.4, 8.5                                     */
/* ------------------------------------------------------------------ */

describe('bookClass — UniqueViolation on confirmed insert', () => {
  it('compensates with INCR, looks up the existing row, returns already_booked, no duplicate outbox', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(10);
    // First insert inside the tx throws the unique-violation.
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    // Then the flow opens a fresh tx and reads back the existing
    // reservation.
    d.findExisting.mockResolvedValueOnce(CONFIRMED_ROW);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'already_booked',
      reservation: CONFIRMED_ROW,
    });

    // Compensating INCR once; never a second DECR.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);

    // Three transactions: the failed insert, the own-hold check (no
    // hold), then the lookup, each under a fresh tx handle.
    expect(d.withTransaction).toHaveBeenCalledTimes(3);
    expect(d.findOwnHold).toHaveBeenCalledExactlyOnceWith(d.txSeen[1], CLASS_ID, USER_ID);
    expect(d.findExisting).toHaveBeenCalledExactlyOnceWith(d.txSeen[2], CLASS_ID, USER_ID);

    // Crucially: no outbox write — this is a replay, not a fresh
    // booking. The event.id was already published on the first
    // successful call.
    expect(d.insertOutbox).not.toHaveBeenCalled();
    expect(d.buildCreated).not.toHaveBeenCalled();
    expect(d.buildWaitlisted).not.toHaveBeenCalled();
  });

  it('also accepts a plain error with code = "UNIQUE_VIOLATION" from the adapter', async () => {
    // The port contract says the adapter may throw either a
    // UniqueViolationError instance OR a generic error with
    // `.code === 'UNIQUE_VIOLATION'`. Both must be handled.
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);

    const adapterError: Error & { code: string } = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: 'UNIQUE_VIOLATION' as const },
    );
    d.insertReservation.mockRejectedValueOnce(adapterError);
    d.findExisting.mockResolvedValueOnce(CONFIRMED_ROW);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'already_booked',
      reservation: CONFIRMED_ROW,
    });
    expect(d.incrRemaining).toHaveBeenCalledOnce();
    expect(d.insertOutbox).not.toHaveBeenCalled();
  });

  it('throws when the unique-violation lookup unexpectedly returns null', async () => {
    // Defensive invariant: a unique-violation MUST imply a
    // pre-existing row. A null lookup means something deleted the
    // row between the INSERT attempt and our SELECT — surface as
    // a generic error so the gateway replies 5xx instead of
    // inventing a success.
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    d.findExisting.mockResolvedValueOnce(null);

    await expect(invoke(d.deps)).rejects.toThrow(/unique-violation.*no live reservation/);

    // Compensating INCR still happened — we must not leak seats.
    expect(d.incrRemaining).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  Re-book after cancellation — issue #468                            */
/* ------------------------------------------------------------------ */

describe('bookClass — re-booking after cancellation (partial unique index)', () => {
  it('succeeds with code ok when INSERT does not raise a UniqueViolationError', async () => {
    // With the partial unique index (migration 0028) covering only
    // confirmed / waitlisted rows, an INSERT for a user who previously
    // cancelled does NOT throw a UniqueViolationError. The booking
    // flow therefore proceeds as a fresh booking and returns code 'ok'.
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(2);
    // INSERT succeeds — no unique-violation from the DB layer.
    d.insertReservation.mockResolvedValueOnce(CONFIRMED_ROW);
    d.countWaitlistAhead.mockResolvedValueOnce(0);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'ok', reservation: CONFIRMED_ROW, remaining: 2 });
    // No compensating INCR — the seat is legitimately claimed.
    expect(d.incrRemaining).not.toHaveBeenCalled();
    // Exactly one transaction and one outbox write.
    expect(d.withTransaction).toHaveBeenCalledOnce();
    expect(d.insertOutbox).toHaveBeenCalledOnce();
    // findExisting must never be called on a clean rebook path.
    expect(d.findExisting).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  UniqueViolation on waitlist insert — Req 8.4, 8.5                  */
/* ------------------------------------------------------------------ */

describe('bookClass — UniqueViolation on waitlist insert (DECR < 0)', () => {
  it('looks up the existing row and returns already_booked, no duplicate outbox', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    // DECR goes negative → waitlist branch
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    // The waitlist INSERT throws UniqueViolationError (duplicate replay)
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    // The fallback lookup returns the pre-existing waitlist row, two
    // waiters ahead of it.
    d.findExisting.mockResolvedValueOnce(WAITLIST_ROW);
    d.countWaitlistAhead.mockResolvedValueOnce(2);

    const result = await invoke(d.deps);

    // The replay reports the real state: waitlist, position 3.
    expect(result).toEqual({
      code: 'already_booked',
      reservation: WAITLIST_ROW,
      position: 3,
    });

    // Compensating INCR (for DECR < 0) was done before entering the
    // waitlist branch — exactly once.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);

    // No second outbox event.
    expect(d.insertOutbox).not.toHaveBeenCalled();
    expect(d.buildWaitlisted).not.toHaveBeenCalled();
    expect(d.buildCreated).not.toHaveBeenCalled();

    // Three withTransaction calls: the failed waitlist insert, the
    // own-hold check (no hold), then the fallback lookup.
    expect(d.withTransaction).toHaveBeenCalledTimes(3);
    expect(d.findExisting).toHaveBeenCalledExactlyOnceWith(d.txSeen[2], CLASS_ID, USER_ID);
  });

  it('throws when the waitlist unique-violation lookup returns null', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    d.findExisting.mockResolvedValueOnce(null);

    await expect(invoke(d.deps)).rejects.toThrow(/unique-violation.*no live reservation/);

    expect(d.incrRemaining).toHaveBeenCalledOnce();
  });

  it('rethrows non-unique errors from the waitlist INSERT without INCR', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    const boom = new Error('db outage');
    d.insertReservation.mockRejectedValueOnce(boom);

    await expect(invoke(d.deps)).rejects.toBe(boom);

    // The compensating INCR for the DECR < 0 happened before entering
    // completeWaitlistBooking — so it was called exactly once.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });
});

/* ------------------------------------------------------------------ */
/*  ClassCapacityExceeded — Req 8.3 (PostgreSQL guard)                 */
/* ------------------------------------------------------------------ */

describe('bookClass — ClassCapacityExceeded on confirmed insert', () => {
  it('compensates with INCR and falls through to waitlist when PG rejects capacity', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(3);
    d.insertReservation
      .mockRejectedValueOnce(new ClassCapacityExceededError())
      .mockResolvedValueOnce(WAITLIST_ROW);
    d.countWaitlistAhead.mockResolvedValueOnce(0);

    const result = await invoke(d.deps);

    expect(result).toEqual({
      code: 'waitlisted',
      reservation: WAITLIST_ROW,
      position: 1,
    });
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
    expect(d.buildCreated).not.toHaveBeenCalled();
    expect(d.buildWaitlisted).toHaveBeenCalledOnce();
    expect(d.insertOutbox).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  class_in_past — Req 8.6                                            */
/* ------------------------------------------------------------------ */

describe('bookClass — class_in_past (Req 8.6)', () => {
  it('rejects a class whose startsAt is in the past before touching Redis', async () => {
    const d = buildDoubles();
    const pastClass: BookingClassRow = {
      ...FUTURE_CLASS,
      startsAt: new Date(FROZEN_NOW - 60 * 60_000),
    };
    d.findClass.mockResolvedValueOnce(pastClass);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'class_in_past' });

    // Crucial: no Redis traffic on this path. A malformed
    // request MUST NOT perturb the seat counter — otherwise
    // replay-happy clients could grief the counter with
    // in-the-past class IDs.
    expect(d.decrRemainingOrInit).not.toHaveBeenCalled();
    expect(d.incrRemaining).not.toHaveBeenCalled();
    expect(d.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a class whose startsAt is exactly now', async () => {
    // Boundary: startsAt === now() is considered "in the past"
    // per Req 8.6 ("startsAt earlier than OR equal to now()").
    const d = buildDoubles();
    const boundaryClass: BookingClassRow = {
      ...FUTURE_CLASS,
      startsAt: new Date(FROZEN_NOW),
    };
    d.findClass.mockResolvedValueOnce(boundaryClass);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'class_in_past' });
    expect(d.decrRemainingOrInit).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  class_not_found                                                    */
/* ------------------------------------------------------------------ */

describe('bookClass — class_not_found', () => {
  it('returns class_not_found when the repo has no row (unknown id or other tenant)', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(null);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'class_not_found' });
    expect(d.decrRemainingOrInit).not.toHaveBeenCalled();
    expect(d.withTransaction).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Arbitrary tx failure — compensation + rethrow                       */
/* ------------------------------------------------------------------ */

describe('bookClass — arbitrary error inside the tx', () => {
  it('compensates with INCR and rethrows on a non-unique DB error', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(3);
    const boom = new Error('neon down');
    d.insertReservation.mockRejectedValueOnce(boom);

    await expect(invoke(d.deps)).rejects.toBe(boom);

    // The DECR we issued claimed a seat we never used — restore
    // the counter so the next booker isn't blocked.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
    // The flow must NOT silently fall through to the waitlist
    // branch on a generic error.
    expect(d.countWaitlistAhead).not.toHaveBeenCalled();
    expect(d.insertOutbox).not.toHaveBeenCalled();
  });

  it('compensates with INCR and rethrows when the outbox insert fails', async () => {
    // insertOutbox runs inside the transaction (Req 16.3) — if it
    // fails, the transaction is rolled back and the flow sees the
    // rejection like any other internal error.
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.insertReservation.mockResolvedValueOnce(CONFIRMED_ROW);
    const boom = new Error('outbox constraint violation');
    d.insertOutbox.mockRejectedValueOnce(boom);

    await expect(invoke(d.deps)).rejects.toBe(boom);
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });
});

/* ------------------------------------------------------------------ */
/*  Reservation row type surface                                       */
/* ------------------------------------------------------------------ */

describe('bookClass — type surface (smoke)', () => {
  it('narrows BookingReservationRow to the Drizzle-inferred select type', () => {
    // Purely a compile-time check: the port's row type and the
    // schema's inferred row type are structurally identical. If
    // they ever drift, TypeScript fails the build.
    const row: BookingReservationRow = CONFIRMED_ROW;
    const backToRow: ReservationRow = row;
    expect(backToRow).toBe(row);
  });
});

/* ------------------------------------------------------------------ */
/*  Database clock and in-transaction re-check                         */
/* ------------------------------------------------------------------ */

describe('bookClass: database clock', () => {
  it('uses the database clock from the pre-flight when no test clock is injected', async () => {
    const d = buildDoubles();
    const { clock: _clock, ...withoutClock } = d.deps;
    void _clock;
    // Worker clock says the class is hours away; the database says
    // it started a minute ago.
    d.findClass.mockResolvedValueOnce({
      ...FUTURE_CLASS,
      dbNow: new Date(FUTURE_CLASS.startsAt.getTime() + 60_000),
    });

    const result = await invoke(withoutClock);

    expect(result).toEqual({ code: 'class_in_past' });
    expect(d.decrRemainingOrInit).not.toHaveBeenCalled();
  });

  it('re-checks inside the transaction and compensates when the class started meanwhile', async () => {
    const d = buildDoubles();
    const { clock: _clock, ...withoutClock } = d.deps;
    void _clock;
    d.findClass.mockResolvedValueOnce({ ...FUTURE_CLASS, dbNow: new Date(FROZEN_NOW) });
    d.decrRemainingOrInit.mockResolvedValueOnce(4);
    d.readClassClock.mockResolvedValueOnce({
      startsAt: FUTURE_CLASS.startsAt,
      now: new Date(FUTURE_CLASS.startsAt.getTime()),
    });

    const result = await invoke(withoutClock);

    expect(result).toEqual({ code: 'class_in_past' });
    expect(d.insertReservation).not.toHaveBeenCalled();
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('answers class_not_found when the class vanished before the transaction', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    d.readClassClock.mockResolvedValueOnce(null);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'class_not_found' });
    expect(d.insertReservation).not.toHaveBeenCalled();
  });
});

describe('bookClass: compensation failures', () => {
  it('logs a failed compensating INCR and still returns the business outcome', async () => {
    const d = buildDoubles();
    const logger = { error: vi.fn() };
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(-1);
    d.incrRemaining.mockRejectedValueOnce(new Error('redis down'));
    d.insertReservation.mockResolvedValueOnce(WAITLIST_ROW);
    d.countWaitlistAhead.mockResolvedValueOnce(0);

    const result = await bookClass({
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      ...d.deps,
      logger,
    });

    expect(result).toMatchObject({ code: 'waitlisted', position: 1 });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'booking: compensating INCR failed',
      expect.objectContaining({ classId: CLASS_ID, reason: 'counter_exhausted' }),
    );
  });

  it('rethrows the original error, not the compensation error', async () => {
    const d = buildDoubles();
    const logger = { error: vi.fn() };
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(3);
    const boom = new Error('db outage');
    d.insertReservation.mockRejectedValueOnce(boom);
    d.incrRemaining.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      bookClass({ classId: CLASS_ID, userId: USER_ID, studioId: STUDIO_ID, ...d.deps, logger }),
    ).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('bookClass: classVersion fence (issue #723)', () => {
  it('refuses a stale classVersion before touching the counter', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce({ ...FUTURE_CLASS, version: 4 });

    const result = await bookClass({
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      classVersion: 3,
      ...d.deps,
    });

    expect(result).toEqual({ code: 'class_changed' });
    expect(d.decrRemainingOrInit).not.toHaveBeenCalled();
    expect(d.withTransaction).not.toHaveBeenCalled();
  });

  it('checks the version under the class lock and compensates when it moved', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.lockClassForBooking.mockResolvedValueOnce({
      startsAt: FUTURE_CLASS.startsAt,
      now: new Date(FROZEN_NOW),
      version: FUTURE_CLASS.version + 1,
    });

    const result = await bookClass({
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      classVersion: FUTURE_CLASS.version,
      ...d.deps,
    });

    expect(result).toEqual({ code: 'class_changed' });
    expect(d.lockClassForBooking).toHaveBeenCalledExactlyOnceWith(d.txSeen[0], CLASS_ID);
    expect(d.readClassClock).not.toHaveBeenCalled();
    expect(d.insertReservation).not.toHaveBeenCalled();
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('books when the version still matches, under the lock', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.insertReservation.mockResolvedValueOnce(CONFIRMED_ROW);

    const result = await bookClass({
      classId: CLASS_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      classVersion: FUTURE_CLASS.version,
      ...d.deps,
    });

    expect(result).toEqual({ code: 'ok', reservation: CONFIRMED_ROW, remaining: 5 });
    expect(d.lockClassForBooking).toHaveBeenCalledOnce();
    expect(d.readClassClock).not.toHaveBeenCalled();
  });

  it('keeps the unlocked clock read when no classVersion is sent', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(5);
    d.insertReservation.mockResolvedValueOnce(CONFIRMED_ROW);

    await invoke(d.deps);

    expect(d.readClassClock).toHaveBeenCalledOnce();
    expect(d.lockClassForBooking).not.toHaveBeenCalled();
  });
});

describe('bookClass: the member already holds a seat (issue #723)', () => {
  it('confirms the member own active hold instead of answering already_booked', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(4);
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    d.findOwnHold.mockResolvedValueOnce({
      id: RESERVATION_ID,
      expiresAt: new Date(FROZEN_NOW + 60_000),
      now: new Date(FROZEN_NOW),
    });
    d.confirmHold.mockResolvedValueOnce(CONFIRMED_ROW);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'ok', reservation: CONFIRMED_ROW, remaining: 4 });
    expect(d.confirmHold).toHaveBeenCalledExactlyOnceWith(d.txSeen[1], RESERVATION_ID);
    // One reservation.created event, written in the confirming tx.
    expect(d.insertOutbox).toHaveBeenCalledExactlyOnceWith(d.txSeen[1], CREATED_EVENT);
    // The booking's own DECR is compensated: the hold already owns the seat.
    expect(d.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
    expect(d.findExisting).not.toHaveBeenCalled();
  });

  it('does not confirm an active hold once the class has started', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValueOnce(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(4);
    d.insertReservation.mockRejectedValueOnce(new UniqueViolationError());
    d.findOwnHold.mockResolvedValueOnce({
      id: RESERVATION_ID,
      expiresAt: new Date(FROZEN_NOW + 60_000),
      now: new Date(FROZEN_NOW),
    });
    // Open for the insert attempt, started by the time the hold is settled.
    d.readClassClock
      .mockResolvedValueOnce({ startsAt: FUTURE_CLASS.startsAt, now: new Date(FROZEN_NOW) })
      .mockResolvedValueOnce({ startsAt: new Date(FROZEN_NOW), now: new Date(FROZEN_NOW) });

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'class_in_past' });
    expect(d.confirmHold).not.toHaveBeenCalled();
    expect(d.insertOutbox).not.toHaveBeenCalled();
  });

  it('releases an expired own hold and books once more', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValue(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValueOnce(4).mockResolvedValueOnce(4);
    d.insertReservation
      .mockRejectedValueOnce(new UniqueViolationError())
      .mockResolvedValueOnce(CONFIRMED_ROW);
    d.findOwnHold.mockResolvedValueOnce({
      id: 'expired-hold',
      expiresAt: new Date(FROZEN_NOW - 1),
      now: new Date(FROZEN_NOW),
    });

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'ok', reservation: CONFIRMED_ROW, remaining: 4 });
    expect(d.releaseHold).toHaveBeenCalledExactlyOnceWith(d.txSeen[1], 'expired-hold');
    expect(d.confirmHold).not.toHaveBeenCalled();
    expect(d.insertReservation).toHaveBeenCalledTimes(2);
  });

  it('retries at most once after releasing an expired hold', async () => {
    const d = buildDoubles();
    d.findClass.mockResolvedValue(FUTURE_CLASS);
    d.decrRemainingOrInit.mockResolvedValue(4);
    d.insertReservation.mockRejectedValue(new UniqueViolationError());
    d.findOwnHold.mockResolvedValue({
      id: 'expired-hold',
      expiresAt: new Date(FROZEN_NOW - 1),
      now: new Date(FROZEN_NOW),
    });
    d.findExisting.mockResolvedValueOnce(CONFIRMED_ROW);

    const result = await invoke(d.deps);

    expect(result).toEqual({ code: 'already_booked', reservation: CONFIRMED_ROW });
    expect(d.insertReservation).toHaveBeenCalledTimes(2);
  });
});
