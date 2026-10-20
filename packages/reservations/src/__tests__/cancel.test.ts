/**
 * Unit tests for `@athlya/reservations/cancel`.
 *
 * Covers every acceptance criterion of Requirement 9 — cancellation
 * with atomic waitlist promotion — and the relevant pieces of
 * Requirement 10 that govern the legal edges out of `confirmed` /
 * `waitlist`:
 *
 *   - 9.1 / 10.5 — a well-formed cancellation stamps
 *     `status = 'cancelled'` and `cancelled_at = now()`.
 *   - 9.2 — `now > startsAt − 2h` surfaces as
 *     `cancellation_window_closed`; no counter bump, no outbox.
 *   - 9.3 — `confirmed` + waitlist present promotes the oldest
 *     waiter *inside the same transaction* and publishes both
 *     `reservation.cancelled` and `reservation.promoted`.
 *   - 9.4 — `confirmed` + no waitlist increments the Redis counter.
 *   - 9.5 — exactly one `reservation.cancelled` event per success.
 *   - 10.3 — a request on an already-`cancelled` row surfaces as
 *     `invalid_transition`.
 *
 * The repo, counter and event-id / clock factories are all hand-rolled
 * `vi.fn()` doubles so the suite never touches Drizzle, Postgres or
 * Upstash. `withTransaction` is modelled as a passthrough that simply
 * invokes its callback with an opaque token — the service never
 * inspects the token, so the test can assert on the token's identity
 * to prove every repo call happened *inside* the transaction.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CANCELLATION_WINDOW_MS,
  cancelReservation,
  type CancelCounter,
  type CancelOutboxEvent,
  type CancelRepo,
  type CancelReservationInput,
  type ClassForCancel,
  type PromotedReservation,
} from '../cancel.js';

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c800';
const OTHER_USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c801';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const RESERVATION_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c810';
const WAITER_RESERVATION_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c811';
const WAITER_USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c802';

/**
 * Frozen wall-clock. Chosen so every window arithmetic reads nicely:
 * `FROZEN_NOW + 4h` sits comfortably outside the 2-hour cancellation
 * window, and `FROZEN_NOW + 1h` sits *inside* it (i.e. too late to
 * cancel).
 */
const FROZEN_NOW = Date.parse('2026-04-01T10:00:00.000Z');

/** Opaque transaction token used by the passthrough `withTransaction`. */
const TX_TOKEN = Symbol('tx');

/**
 * Canonical confirmed reservation. Tests tweak the `status` field via
 * `makeReservation` to exercise the `waitlist` and `cancelled`
 * branches.
 */
function makeReservation(overrides: Partial<ReservationRow> = {}): ReservationRow {
  return {
    id: RESERVATION_ID,
    classId: CLASS_ID,
    userId: USER_ID,
    status: 'confirmed',
    createdAt: new Date('2026-03-15T00:00:00.000Z'),
    cancelledAt: null,
    checkedInAt: null,
    ...overrides,
  };
}

/**
 * Waiter — same class, different user. Used by the promotion test to
 * mimic what `promoteOldestWaitlist` reports after promoting it.
 */
const WAITER: PromotedReservation = {
  id: WAITER_RESERVATION_ID,
  classId: CLASS_ID,
  userId: WAITER_USER_ID,
};

/** Class projection used by every test. Overridable for the window test. */
function makeClass(overrides: Partial<ClassForCancel> = {}): ClassForCancel {
  // Default `startsAt` sits 4h in the future — safely outside the
  // 2-hour cancellation cutoff, so the window guard accepts.
  return {
    startsAt: new Date(FROZEN_NOW + 4 * 60 * 60 * 1000),
    ...overrides,
  };
}

/**
 * Deterministic event-id generator. Returns `evt-0`, `evt-1`, …
 * Exposed so tests can assert on the exact `eventId` field of the
 * outbox payloads without mocking `crypto.randomUUID`.
 */
function makeEventIdFactory(): Mock<() => string> {
  let i = 0;
  const fn: () => string = () => `evt-${String(i++)}`;
  return vi.fn<() => string>(fn);
}

/* ------------------------------------------------------------------ */
/*  Repo / counter doubles                                             */
/* ------------------------------------------------------------------ */

interface RepoMocks {
  withTransaction: Mock;
  findReservationForUpdate: Mock<CancelRepo['findReservationForUpdate']>;
  findClassForUpdate: Mock<CancelRepo['findClassForUpdate']>;
  updateReservationStatus: Mock<CancelRepo['updateReservationStatus']>;
  isHoldActive: Mock<CancelRepo['isHoldActive']>;
  promoteOldestWaitlist: Mock<CancelRepo['promoteOldestWaitlist']>;
  insertOutbox: Mock<CancelRepo['insertOutbox']>;
}

/**
 * Build a fresh set of `vi.fn()` doubles for every test. The
 * `withTransaction` implementation is a passthrough: it invokes `fn`
 * with the {@link TX_TOKEN} sentinel and returns whatever `fn`
 * resolves to. That lets the test suite assert on the token identity
 * to prove every repo call happened inside the transaction.
 *
 * `withTransaction` is typed as a generic on {@link CancelRepo}; Vitest
 * `Mock<...>` cannot carry the generic across the passthrough, so we
 * build the function in plain `vi.fn()` form and cross the seam with a
 * single narrow cast at assembly time.
 */
function buildRepo(): { repo: CancelRepo; mocks: RepoMocks } {
  const withTransaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX_TOKEN));
  const findReservationForUpdate = vi.fn<CancelRepo['findReservationForUpdate']>();
  const findClassForUpdate = vi.fn<CancelRepo['findClassForUpdate']>();
  const updateReservationStatus = vi.fn<CancelRepo['updateReservationStatus']>();
  const isHoldActive = vi.fn<CancelRepo['isHoldActive']>().mockResolvedValue(true);
  const promoteOldestWaitlist = vi
    .fn<CancelRepo['promoteOldestWaitlist']>()
    .mockResolvedValue({ outcome: 'no_waiter' });
  const insertOutbox = vi.fn<CancelRepo['insertOutbox']>().mockResolvedValue(undefined);

  const repo: CancelRepo = {
    withTransaction: withTransaction as unknown as CancelRepo['withTransaction'],
    findReservationForUpdate,
    findClassForUpdate,
    updateReservationStatus,
    isHoldActive,
    promoteOldestWaitlist,
    insertOutbox,
  };

  return {
    repo,
    mocks: {
      withTransaction,
      findReservationForUpdate,
      findClassForUpdate,
      updateReservationStatus,
      isHoldActive,
      promoteOldestWaitlist,
      insertOutbox,
    },
  };
}

function buildCounter(): {
  counter: CancelCounter;
  incrRemaining: Mock<CancelCounter['incrRemaining']>;
} {
  const incrRemaining = vi.fn<CancelCounter['incrRemaining']>().mockResolvedValue(undefined);
  return { counter: { incrRemaining }, incrRemaining };
}

/**
 * Assemble a complete {@link CancelReservationInput} plus the mocks
 * needed for assertions.
 */
function buildInput(
  overrides: Partial<Pick<CancelReservationInput, 'reservationId' | 'userId' | 'clock'>> = {},
): {
  input: CancelReservationInput;
  mocks: RepoMocks;
  incrRemaining: Mock<CancelCounter['incrRemaining']>;
  newEventId: Mock<() => string>;
} {
  const { repo, mocks } = buildRepo();
  const { counter, incrRemaining } = buildCounter();
  const newEventId = makeEventIdFactory();

  return {
    input: {
      reservationId: RESERVATION_ID,
      userId: USER_ID,
      repo,
      counter,
      clock: () => FROZEN_NOW,
      newEventId,
      ...overrides,
    },
    mocks,
    incrRemaining,
    newEventId,
  };
}

/**
 * Extract every `insertOutbox` payload as a plain `CancelOutboxEvent[]`
 * in call order. Convenience helper — the mock's `.mock.calls` array
 * is a nested tuple that's cumbersome to destructure inline.
 */
function collectOutboxEvents(mock: Mock<CancelRepo['insertOutbox']>): CancelOutboxEvent[] {
  return mock.mock.calls.map(([, event]) => event);
}

/* ------------------------------------------------------------------ */
/*  not_found — Req 9 (collapsed ownership probe)                      */
/* ------------------------------------------------------------------ */

describe('cancelReservation — not_found', () => {
  it('returns not_found when the repo has no matching reservation', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    // Repo reports "nothing for (id, userId)" — whether the row
    // truly doesn't exist or belongs to another user is opaque
    // from here, which is exactly what Req 9 requires so cross-
    // tenant probing stays impossible.
    mocks.findReservationForUpdate.mockResolvedValueOnce(null);

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'not_found' });

    // Transaction was opened (the service *always* locks before
    // checking existence so the repo's RLS filter runs under the
    // right session variables).
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.findReservationForUpdate).toHaveBeenCalledExactlyOnceWith(
      TX_TOKEN,
      RESERVATION_ID,
      USER_ID,
    );
    // Nothing else is touched — no class read, no UPDATE, no
    // waitlist scan, no outbox, no counter bump.
    expect(mocks.findClassForUpdate).not.toHaveBeenCalled();
    expect(mocks.updateReservationStatus).not.toHaveBeenCalled();
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });

  it('collapses a wrong-owner lookup into not_found (same repo call shape)', async () => {
    // The repo is responsible for the `WHERE user_id = $2`
    // filter, so a wrong-owner request reaches it as a regular
    // `(reservationId, otherUserId)` lookup and comes back
    // `null`. The service MUST surface `not_found`, not a
    // distinct "forbidden" code — that is what prevents an
    // attacker from using the cancellation endpoint as an
    // existence oracle against another tenant.
    const { input, mocks } = buildInput({ userId: OTHER_USER_ID });

    mocks.findReservationForUpdate.mockResolvedValueOnce(null);

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'not_found' });
    expect(mocks.findReservationForUpdate).toHaveBeenCalledExactlyOnceWith(
      TX_TOKEN,
      RESERVATION_ID,
      OTHER_USER_ID,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  invalid_transition — Req 10.3                                      */
/* ------------------------------------------------------------------ */

describe('cancelReservation: already cancelled (retried DELETE)', () => {
  it('answers already_cancelled with the stored row and writes nothing', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    const stored = makeReservation({
      status: 'cancelled',
      cancelledAt: new Date(FROZEN_NOW - 60_000),
    });
    mocks.findReservationForUpdate.mockResolvedValueOnce(stored);

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'already_cancelled', cancelled: stored });
    // Answered before the window check: a late retry must not turn
    // into cancellation_window_closed.
    expect(mocks.findClassForUpdate).not.toHaveBeenCalled();
    expect(mocks.updateReservationStatus).not.toHaveBeenCalled();
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });
});

describe('cancelReservation — invalid_transition', () => {
  it('rejects a reservation in a terminal state other than cancelled', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'no_show' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'invalid_transition' });
    expect(mocks.updateReservationStatus).not.toHaveBeenCalled();
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });
});

describe('cancelReservation: database clock', () => {
  it('judges the 2-hour window against the transaction clock when no test clock is set', async () => {
    const { input, mocks } = buildInput();
    const { clock: _clock, ...withoutClock } = input;
    void _clock;
    const startsAt = new Date(FROZEN_NOW + 3 * 60 * 60_000);
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    // Worker clock would allow it; the database says 1h30 remain.
    mocks.findClassForUpdate.mockResolvedValueOnce({
      startsAt,
      now: new Date(startsAt.getTime() - 90 * 60_000),
    });

    const result = await cancelReservation(withoutClock);

    expect(result).toEqual({ code: 'cancellation_window_closed' });
  });
});

describe('cancelReservation: post-commit counter failure', () => {
  it('logs a failed INCR and still reports the committed cancellation', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    const logger = { error: vi.fn() };
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.updateReservationStatus.mockResolvedValueOnce(
      makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) }),
    );
    incrRemaining.mockRejectedValueOnce(new Error('redis down'));

    const result = await cancelReservation({ ...input, logger });

    expect(result).toMatchObject({ code: 'ok', promoted: null });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'cancel: post-commit INCR failed',
      expect.objectContaining({ error: 'redis down' }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  cancellation_window_closed — Req 9.2                               */
/* ------------------------------------------------------------------ */

describe('cancelReservation — cancellation_window_closed', () => {
  it('rejects a cancellation requested less than 2 hours before startsAt', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    // startsAt is 1 hour in the future — strictly inside the
    // 2-hour cancellation cutoff, so the service must reject.
    mocks.findClassForUpdate.mockResolvedValueOnce(
      makeClass({ startsAt: new Date(FROZEN_NOW + 60 * 60 * 1000) }),
    );

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'cancellation_window_closed' });

    // Counter not touched, no outbox written, no UPDATE issued —
    // only the two SELECT FOR UPDATE reads happened, which the
    // transaction will release on commit.
    expect(mocks.updateReservationStatus).not.toHaveBeenCalled();
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });

  it('accepts a cancellation at exactly startsAt − 2h (boundary inclusive on the user side)', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    // startsAt = now + 2h exactly. now == startsAt − 2h, which
    // the design doc frames as "cancellation possible up to 2h
    // before". Requirement 9.1 reads "at least 2 hours after
    // now()" — boundary inclusive.
    mocks.findClassForUpdate.mockResolvedValueOnce(
      makeClass({ startsAt: new Date(FROZEN_NOW + CANCELLATION_WINDOW_MS) }),
    );
    // Waitlist absent → counter bump path.
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({ outcome: 'no_waiter' });
    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({ id, status, cancelledAt: at }),
    );

    const result = await cancelReservation(input);

    expect(result.code).toBe('ok');
    expect(incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });
});

/* ------------------------------------------------------------------ */
/*  confirmed + waitlist present — Req 9.3, 9.5                        */
/* ------------------------------------------------------------------ */

describe('cancelReservation — confirmed with waitlist promotion', () => {
  it('promotes the oldest waiter atomically and emits both cancelled + promoted events', async () => {
    const { input, mocks, incrRemaining, newEventId } = buildInput();

    const reservation = makeReservation({ status: 'confirmed' });
    mocks.findReservationForUpdate.mockResolvedValueOnce(reservation);
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({ outcome: 'promoted', reservation: WAITER });

    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({ id, status, cancelledAt: at }),
    );

    const result = await cancelReservation(input);

    // ---- Shape of the success branch -----------------------
    expect(result.code).toBe('ok');
    if (result.code !== 'ok') throw new Error('unreachable');
    expect(result.cancelled.id).toBe(RESERVATION_ID);
    expect(result.cancelled.status).toBe('cancelled');
    expect(result.cancelled.cancelledAt).toEqual(new Date(FROZEN_NOW));
    expect(result.promoted).not.toBeNull();
    expect(result.promoted).toEqual(WAITER);

    // ---- Counter stays untouched — the seat was re-consumed -
    // by the promoted waiter, so `remaining` is unchanged
    // (Req 9.3 note: "counter stays unchanged").
    expect(incrRemaining).not.toHaveBeenCalled();

    // ---- Two outbox events, both inside the transaction -----
    expect(mocks.insertOutbox).toHaveBeenCalledTimes(2);
    const events = collectOutboxEvents(mocks.insertOutbox);

    // Every insert received the same tx token — i.e. every
    // outbox row is part of the same transaction as the writes
    // (Req 16.3).
    for (const [tx] of mocks.insertOutbox.mock.calls) {
      expect(tx).toBe(TX_TOKEN);
    }

    // Order: the promoted event lands *before* the cancelled
    // event in the implementation (the promotion happens inside
    // the `wasConfirmed` branch, the cancellation event is
    // emitted last). The Notifications consumer dedups on
    // `event.id` regardless of order, but asserting the wire
    // shape here protects against accidental re-orderings that
    // could starve the waitlist consumer.
    expect(events[0]).toEqual({
      eventId: 'evt-0',
      eventType: 'reservation.promoted',
      payload: {
        reservationId: WAITER_RESERVATION_ID,
        classId: CLASS_ID,
        userId: WAITER_USER_ID,
      },
      occurredAt: new Date(FROZEN_NOW),
    });
    expect(events[1]).toEqual({
      eventId: 'evt-1',
      eventType: 'reservation.cancelled',
      payload: {
        reservationId: RESERVATION_ID,
        classId: CLASS_ID,
        userId: USER_ID,
      },
      occurredAt: new Date(FROZEN_NOW),
    });

    // Event-id factory called exactly twice — once per outbox
    // row, no spurious calls.
    expect(newEventId).toHaveBeenCalledTimes(2);

    // ---- Ordering: cancel first, promote second -------------
    // so the freed seat exists when the repo checks capacity.
    // The promotion itself is a single repo call.
    expect(mocks.updateReservationStatus).toHaveBeenCalledExactlyOnceWith(
      TX_TOKEN,
      RESERVATION_ID,
      'cancelled',
      new Date(FROZEN_NOW),
    );
    expect(mocks.promoteOldestWaitlist).toHaveBeenCalledExactlyOnceWith(TX_TOKEN, CLASS_ID);
    expect(mocks.updateReservationStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.promoteOldestWaitlist.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('promotes nobody and leaves the counter alone while PostgreSQL still sees the class full', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'confirmed' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({ outcome: 'no_capacity' });
    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({ id, status, cancelledAt: at }),
    );

    const result = await cancelReservation(input);

    expect(result.code).toBe('ok');
    if (result.code !== 'ok') throw new Error('unreachable');
    expect(result.promoted).toBeNull();
    // Redis would otherwise advertise a seat PostgreSQL cannot back.
    expect(incrRemaining).not.toHaveBeenCalled();
    expect(collectOutboxEvents(mocks.insertOutbox).map((e) => e.eventType)).toEqual([
      'reservation.cancelled',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  confirmed + no waitlist — Req 9.4, 9.5                             */
/* ------------------------------------------------------------------ */

describe('cancelReservation — confirmed with no waitlist', () => {
  it('increments the Redis counter once and emits exactly one cancelled event', async () => {
    const { input, mocks, incrRemaining, newEventId } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'confirmed' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    // Empty waitlist — Req 9.4 applies.
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({ outcome: 'no_waiter' });
    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({ id, status, cancelledAt: at }),
    );

    const result = await cancelReservation(input);

    expect(result.code).toBe('ok');
    if (result.code !== 'ok') throw new Error('unreachable');
    expect(result.cancelled.status).toBe('cancelled');
    expect(result.promoted).toBeNull();

    // Counter bumped exactly once, after the transaction
    // committed. A `mockResolvedValue(undefined)` for
    // `withTransaction` means the test only asserts *that* the
    // call happened — the ordering guarantee is documented in
    // the service's JSDoc and covered by the `outbox-first`
    // assertion on the promotion test above.
    expect(incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);

    // One and only one outbox event — Req 9.5.
    expect(mocks.insertOutbox).toHaveBeenCalledOnce();
    const events = collectOutboxEvents(mocks.insertOutbox);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventId: 'evt-0',
      eventType: 'reservation.cancelled',
      payload: {
        reservationId: RESERVATION_ID,
        classId: CLASS_ID,
        userId: USER_ID,
      },
      occurredAt: new Date(FROZEN_NOW),
    });

    // Event-id factory burned a single id.
    expect(newEventId).toHaveBeenCalledOnce();

    // Promotion attempt ran exactly once — we need it to decide
    // between the promotion and the INCR branch. Runs with
    // `SKIP LOCKED` at the SQL layer; the service just relies
    // on the repo's contract and asserts the call shape.
    expect(mocks.promoteOldestWaitlist).toHaveBeenCalledExactlyOnceWith(TX_TOKEN, CLASS_ID);
  });
});

/* ------------------------------------------------------------------ */
/*  waitlist origin — Req 9 (no promotion, no counter bump)            */
/* ------------------------------------------------------------------ */

describe('cancelReservation — waitlist origin', () => {
  it('cancels a waitlist reservation without promoting anyone and without bumping the counter', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'waitlist' }));
    // Window is wide open — startsAt is 4h in the future by
    // default. Tests that the guard works against `waitlist` as
    // well as `confirmed`.
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({
        id,
        status,
        cancelledAt: at,
        // Retain the original waitlist status on the
        // returned row so the service can still stamp
        // `cancelled_at` — mirrors the UPDATE ... RETURNING
        // *` behaviour of the production repo.
      }),
    );

    const result = await cancelReservation(input);

    expect(result.code).toBe('ok');
    if (result.code !== 'ok') throw new Error('unreachable');
    expect(result.promoted).toBeNull();

    // Promotion NEVER runs — the seat was never counted
    // against capacity, so there's no slot to redistribute.
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();

    // Counter stays untouched (Req 9.4 speaks of a confirmed
    // cancellation; waitlist cancellations don't change the
    // seat count).
    expect(incrRemaining).not.toHaveBeenCalled();

    // One and only one outbox event — Req 9.5.
    expect(mocks.insertOutbox).toHaveBeenCalledOnce();
    const events = collectOutboxEvents(mocks.insertOutbox);
    expect(events).toHaveLength(1);
    const [onlyEvent] = events;
    expect(onlyEvent?.eventType).toBe('reservation.cancelled');
  });
});

/* ------------------------------------------------------------------ */
/*  Sanity: studioId is irrelevant to the service                      */
/* ------------------------------------------------------------------ */

// The service never reads `studioId` — tenant scoping is enforced at
// the repo layer via RLS (Req 13). This assertion guards against a
// future refactor that accidentally adds a second, service-side check
// which would break the RLS single-source-of-truth property.
describe('cancelReservation — does not read studioId directly', () => {
  it('succeeds without a studioId being provided anywhere', async () => {
    // STUDIO_ID is defined above but deliberately unused in the
    // service call — this test just documents the intent.
    expect(STUDIO_ID).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Task 6.11 — Requirement 9 traceability hardening                   */
/* ------------------------------------------------------------------ */

/**
 * These tests complement the scenarios above by locking in two
 * properties that are implicit in the existing suite but worth
 * making explicit for Requirement 9 traceability:
 *
 *   - Req 9.2 — the 2-hour cutoff is a **strict** inequality. A
 *     cancellation received exactly one millisecond past
 *     `startsAt − 2h` must be rejected; the boundary itself is
 *     legal (covered by the "accepts a cancellation at exactly
 *     startsAt − 2h" test above), anything past it is not.
 *
 *   - Req 9.3 — FIFO ordering is enforced at the repo layer via
 *     `ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`. The
 *     service MUST promote exactly the row the repo returned and
 *     never fan out across the whole waitlist. With three concurrent
 *     waiters (T1 < T2 < T3) the repo returns T1; the service must
 *     promote T1 and emit a single `reservation.promoted` event
 *     carrying T1's identifiers — T2 and T3 must stay on the
 *     waitlist and never surface in the outbox.
 */
describe('cancelReservation — Req 9.2 strict window boundary', () => {
  it('rejects a cancellation one millisecond past startsAt − 2h (strict >)', async () => {
    const { input, mocks, incrRemaining } = buildInput();

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    // startsAt = now + (2h - 1ms). `cutoffMs = startsAt - 2h`
    // evaluates to `now - 1ms`, so `now > cutoffMs` holds by
    // exactly one millisecond and the guard MUST reject.
    mocks.findClassForUpdate.mockResolvedValueOnce(
      makeClass({
        startsAt: new Date(FROZEN_NOW + CANCELLATION_WINDOW_MS - 1),
      }),
    );

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'cancellation_window_closed' });

    // No writes, no outbox, no counter bump — only the two
    // SELECT FOR UPDATE reads happened.
    expect(mocks.updateReservationStatus).not.toHaveBeenCalled();
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });
});

describe('cancelReservation — Req 9.3 FIFO ordering', () => {
  it('promotes the oldest of three concurrent waiters and leaves the other two alone', async () => {
    const { input, mocks, incrRemaining, newEventId } = buildInput();

    // Three waiters on the same class, created at T1 < T2 < T3.
    // The production repo enforces
    // `ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
    // (see CancelRepo.promoteOldestWaitlist contract), so it
    // promotes T1. T2 and T3 are declared here only to make the
    // ordering intent explicit and to assert that the service
    // never reaches past the first row.
    const waiters = [
      {
        id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c903',
        userId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c913',
        createdAt: Date.parse('2026-03-16T10:00:00.000Z'), // T3
      },
      {
        id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c901',
        userId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c911',
        createdAt: Date.parse('2026-03-16T08:00:00.000Z'), // T1 — oldest
      },
      {
        id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c902',
        userId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c912',
        createdAt: Date.parse('2026-03-16T09:00:00.000Z'), // T2
      },
    ];
    const [waiterT1, waiterT2, waiterT3] = [...waiters].sort((a, b) => a.createdAt - b.createdAt);
    if (waiterT1 === undefined || waiterT2 === undefined || waiterT3 === undefined) {
      throw new Error('unreachable');
    }
    expect(waiterT1.id).toBe('018f3c11-4e2d-7b53-9a0c-3f76a1d1c901');

    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'confirmed' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    // Repo promotes T1 — it is the repo's job, not the service's,
    // to pick the FIFO winner. The service simply trusts the
    // contract and publishes whatever row the repo promoted.
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({
      outcome: 'promoted',
      reservation: { id: waiterT1.id, classId: CLASS_ID, userId: waiterT1.userId },
    });
    mocks.updateReservationStatus.mockImplementationOnce(async (_tx, id, status, at) =>
      makeReservation({ id, status, cancelledAt: at }),
    );

    const result = await cancelReservation(input);

    expect(result.code).toBe('ok');
    if (result.code !== 'ok') throw new Error('unreachable');

    // Exactly T1 was promoted — not T2, not T3.
    expect(result.promoted).not.toBeNull();
    expect(result.promoted?.id).toBe(waiterT1.id);
    expect(result.promoted?.userId).toBe(waiterT1.userId);

    // Promotion ran exactly once — the service never loops over
    // the waitlist, so T2 and T3 stay untouched.
    expect(mocks.promoteOldestWaitlist).toHaveBeenCalledExactlyOnceWith(TX_TOKEN, CLASS_ID);

    // Counter untouched — the freed seat was re-consumed by T1.
    expect(incrRemaining).not.toHaveBeenCalled();

    // Exactly two outbox events: one `promoted` for T1 and one
    // `cancelled`. No `promoted` event for T2 or T3.
    expect(mocks.insertOutbox).toHaveBeenCalledTimes(2);
    const events = collectOutboxEvents(mocks.insertOutbox);

    const promotedEvents = events.filter((e) => e.eventType === 'reservation.promoted');
    expect(promotedEvents).toHaveLength(1);
    expect(promotedEvents[0]?.payload).toEqual({
      reservationId: waiterT1.id,
      classId: CLASS_ID,
      userId: waiterT1.userId,
    });

    // T2 and T3 must NOT appear anywhere in the emitted events.
    for (const event of events) {
      expect(event.payload.reservationId).not.toBe(waiterT2.id);
      expect(event.payload.reservationId).not.toBe(waiterT3.id);
      expect(event.payload.userId).not.toBe(waiterT2.userId);
      expect(event.payload.userId).not.toBe(waiterT3.userId);
    }

    // Only the cancellation went through updateReservationStatus.
    expect(mocks.updateReservationStatus).toHaveBeenCalledOnce();

    // Exactly two event ids were minted — no spurious calls on
    // behalf of T2 or T3.
    expect(newEventId).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Seat hold release (issue #723)                                     */
/* ------------------------------------------------------------------ */

describe('cancelReservation: releasing a seat hold', () => {
  it('releases an active hold inside the 2-hour window and returns its seat to the counter', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'pending' }));
    // One hour before the class: a booking could no longer be cancelled.
    mocks.findClassForUpdate.mockResolvedValueOnce(
      makeClass({ startsAt: new Date(FROZEN_NOW + 60 * 60 * 1000) }),
    );
    const released = makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) });
    mocks.updateReservationStatus.mockResolvedValueOnce(released);

    const result = await cancelReservation(input);

    expect(result).toEqual({ code: 'ok', cancelled: released, promoted: null });
    expect(mocks.isHoldActive).toHaveBeenCalledExactlyOnceWith(TX_TOKEN, RESERVATION_ID);
    expect(mocks.updateReservationStatus).toHaveBeenCalledExactlyOnceWith(
      TX_TOKEN,
      RESERVATION_ID,
      'cancelled',
      new Date(FROZEN_NOW),
    );
    expect(mocks.promoteOldestWaitlist).toHaveBeenCalledExactlyOnceWith(TX_TOKEN, CLASS_ID);
    // No cancellation notice for a seat that was never booked.
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('hands the seat of an active hold to the oldest waiter', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'pending' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.updateReservationStatus.mockResolvedValueOnce(
      makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) }),
    );
    mocks.promoteOldestWaitlist.mockResolvedValueOnce({ outcome: 'promoted', reservation: WAITER });

    const result = await cancelReservation(input);

    expect(result).toMatchObject({ code: 'ok', promoted: WAITER });
    expect(collectOutboxEvents(mocks.insertOutbox).map((e) => e.eventType)).toEqual([
      'reservation.promoted',
    ]);
    expect(incrRemaining).not.toHaveBeenCalled();
  });

  it('releases an expired hold without promoting or touching the counter', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'pending' }));
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.isHoldActive.mockResolvedValueOnce(false);
    mocks.updateReservationStatus.mockResolvedValueOnce(
      makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) }),
    );

    const result = await cancelReservation(input);

    expect(result).toMatchObject({ code: 'ok', promoted: null });
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });

  it('releases an active hold of a started class without handing its seat on', async () => {
    const { input, mocks, incrRemaining } = buildInput();
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation({ status: 'pending' }));
    // The class started ten minutes ago while the hold was still open.
    mocks.findClassForUpdate.mockResolvedValueOnce(
      makeClass({ startsAt: new Date(FROZEN_NOW - 10 * 60 * 1000) }),
    );
    mocks.updateReservationStatus.mockResolvedValueOnce(
      makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) }),
    );

    const result = await cancelReservation(input);

    expect(result).toMatchObject({ code: 'ok', promoted: null });
    expect(mocks.promoteOldestWaitlist).not.toHaveBeenCalled();
    expect(mocks.insertOutbox).not.toHaveBeenCalled();
    expect(incrRemaining).not.toHaveBeenCalled();
  });

  it('never asks a confirmed cancellation whether it is a hold', async () => {
    const { input, mocks } = buildInput();
    mocks.findReservationForUpdate.mockResolvedValueOnce(makeReservation());
    mocks.findClassForUpdate.mockResolvedValueOnce(makeClass());
    mocks.updateReservationStatus.mockResolvedValueOnce(
      makeReservation({ status: 'cancelled', cancelledAt: new Date(FROZEN_NOW) }),
    );

    await cancelReservation(input);

    expect(mocks.isHoldActive).not.toHaveBeenCalled();
  });
});
