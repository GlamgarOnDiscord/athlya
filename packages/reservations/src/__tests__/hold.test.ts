/**
 * Unit tests for `@athlya/reservations/hold` (issue #723): placing,
 * re-placing and confirming seat holds against port doubles. The
 * database guarantees themselves (capacity, expiry, one live row) are
 * proven by the pgTAP suite `booking_holds_fencing.sql` and the Docker
 * concurrency suite.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  ClassCapacityExceededError,
  HoldExpiredError,
  UniqueViolationError,
  type BookingClassRow,
  type BookingCounter,
  type BookingEventPublisher,
  type BookingOutboxEvent,
  type BookingTx,
} from '../book.js';
import {
  DEFAULT_HOLD_TTL_SECONDS,
  MAX_HOLD_TTL_SECONDS,
  confirmHold,
  placeHold,
  type HeldSeat,
  type HoldRepo,
} from '../hold.js';

import type { ReservationRow } from '@athlya/db/schema';

const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c9ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c9ac';
const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c900';
const HOLD_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c910';
const NOW = Date.parse('2026-05-01T10:00:00.000Z');

const CLASS: BookingClassRow = {
  id: CLASS_ID,
  studioId: STUDIO_ID,
  capacity: 10,
  startsAt: new Date(NOW + 24 * 60 * 60_000),
  version: 2,
  dbNow: new Date(NOW),
};

const HOLD: HeldSeat = {
  reservationId: HOLD_ID,
  classId: CLASS_ID,
  expiresAt: new Date(NOW + DEFAULT_HOLD_TTL_SECONDS * 1000),
};

function row(status: ReservationRow['status']): ReservationRow {
  return {
    id: HOLD_ID,
    classId: CLASS_ID,
    userId: USER_ID,
    status,
    createdAt: new Date(NOW),
    cancelledAt: null,
    checkedInAt: null,
  };
}

const CREATED: BookingOutboxEvent = {
  eventId: 'evt-created',
  eventType: 'reservation.created',
  payload: { reservationId: HOLD_ID, classId: CLASS_ID, userId: USER_ID },
  occurredAt: new Date(NOW),
};

type Mocked<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? Mock<T[K]> : T[K] };

function doubles(): {
  repo: HoldRepo;
  m: Mocked<Omit<HoldRepo, 'withTransaction'>>;
  counter: { decrRemaining: Mock; decrRemainingOrInit: Mock; incrRemaining: Mock };
  publisher: BookingEventPublisher;
  txs: BookingTx[];
} {
  const txs: BookingTx[] = [];
  const m = {
    findClass: vi.fn<HoldRepo['findClass']>().mockResolvedValue(CLASS),
    readClassClock: vi
      .fn<HoldRepo['readClassClock']>()
      .mockResolvedValue({ startsAt: CLASS.startsAt, now: new Date(NOW) }),
    lockClassForBooking: vi
      .fn<HoldRepo['lockClassForBooking']>()
      .mockResolvedValue({ startsAt: CLASS.startsAt, now: new Date(NOW), version: CLASS.version }),
    findOwnHold: vi.fn<HoldRepo['findOwnHold']>().mockResolvedValue(null),
    confirmHold: vi.fn<HoldRepo['confirmHold']>(),
    releaseHold: vi.fn<HoldRepo['releaseHold']>().mockResolvedValue(undefined),
    insertOutbox: vi.fn<HoldRepo['insertOutbox']>().mockResolvedValue(undefined),
    findExistingConfirmedOrWaitlistReservation:
      vi.fn<HoldRepo['findExistingConfirmedOrWaitlistReservation']>(),
    countWaitlistAhead: vi.fn<HoldRepo['countWaitlistAhead']>().mockResolvedValue(0),
    insertHold: vi.fn<HoldRepo['insertHold']>().mockResolvedValue(HOLD),
    findReservationForUpdate: vi.fn<HoldRepo['findReservationForUpdate']>(),
  };
  const withTransaction = vi.fn(async (fn: (tx: BookingTx) => Promise<unknown>) => {
    const tx: BookingTx = { __brand: 'BookingTx' };
    txs.push(tx);
    return fn(tx);
  });
  const repo: HoldRepo = {
    ...m,
    withTransaction: withTransaction as unknown as HoldRepo['withTransaction'],
  };
  const counter = {
    decrRemaining: vi.fn<BookingCounter['decrRemaining']>(),
    decrRemainingOrInit: vi.fn<BookingCounter['decrRemainingOrInit']>().mockResolvedValue(3),
    incrRemaining: vi.fn<BookingCounter['incrRemaining']>().mockResolvedValue(0),
  };
  const publisher: BookingEventPublisher = {
    buildReservationCreated: vi.fn().mockReturnValue(CREATED),
    buildReservationWaitlisted: vi.fn(),
  };
  return { repo, m, counter, publisher, txs };
}

function hold(
  d: ReturnType<typeof doubles>,
  extra: { classVersion?: number; ttlSeconds?: number } = {},
): ReturnType<typeof placeHold> {
  return placeHold({
    classId: CLASS_ID,
    userId: USER_ID,
    studioId: STUDIO_ID,
    repo: d.repo,
    counter: d.counter,
    logger: { error: () => undefined },
    ...extra,
  });
}

describe('placeHold', () => {
  it('holds a seat for the default TTL and keeps the DECR', async () => {
    const d = doubles();

    await expect(hold(d)).resolves.toEqual({ code: 'held', hold: HOLD });

    expect(d.m.insertHold).toHaveBeenCalledExactlyOnceWith(d.txs[0], {
      classId: CLASS_ID,
      userId: USER_ID,
      ttlSeconds: DEFAULT_HOLD_TTL_SECONDS,
    });
    expect(d.counter.decrRemainingOrInit).toHaveBeenCalledExactlyOnceWith(CLASS_ID, CLASS.capacity);
    expect(d.counter.incrRemaining).not.toHaveBeenCalled();
    // A hold is not a booking: no outbox event.
    expect(d.m.insertOutbox).not.toHaveBeenCalled();
  });

  it('rejects a TTL the database would refuse', async () => {
    const d = doubles();
    await expect(hold(d, { ttlSeconds: MAX_HOLD_TTL_SECONDS + 1 })).rejects.toThrow(RangeError);
    await expect(hold(d, { ttlSeconds: 0 })).rejects.toThrow(RangeError);
    expect(d.counter.decrRemainingOrInit).not.toHaveBeenCalled();
  });

  it('answers class_full without a transaction when the counter is exhausted', async () => {
    const d = doubles();
    d.counter.decrRemainingOrInit.mockResolvedValueOnce(-1);

    await expect(hold(d)).resolves.toEqual({ code: 'class_full' });
    expect(d.counter.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
    expect(d.m.insertHold).not.toHaveBeenCalled();
  });

  it('answers class_full and compensates when the capacity trigger refuses', async () => {
    const d = doubles();
    d.m.insertHold.mockRejectedValueOnce(new ClassCapacityExceededError());

    await expect(hold(d)).resolves.toEqual({ code: 'class_full' });
    expect(d.counter.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('returns the member own active hold instead of placing a second one', async () => {
    const d = doubles();
    d.m.findOwnHold.mockResolvedValueOnce({
      id: HOLD_ID,
      expiresAt: HOLD.expiresAt,
      now: new Date(NOW),
    });

    await expect(hold(d)).resolves.toEqual({ code: 'already_held', hold: HOLD });
    expect(d.m.insertHold).not.toHaveBeenCalled();
    expect(d.counter.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('releases the member own expired hold, then holds again', async () => {
    const d = doubles();
    d.m.findOwnHold.mockResolvedValueOnce({
      id: 'old-hold',
      expiresAt: new Date(NOW - 1),
      now: new Date(NOW),
    });

    await expect(hold(d)).resolves.toEqual({ code: 'held', hold: HOLD });
    expect(d.m.releaseHold).toHaveBeenCalledExactlyOnceWith(d.txs[0], 'old-hold');
    expect(d.m.insertHold).toHaveBeenCalledOnce();
  });

  it('answers already_booked with the member confirmed row', async () => {
    const d = doubles();
    d.m.insertHold.mockRejectedValueOnce(new UniqueViolationError());
    d.m.findExistingConfirmedOrWaitlistReservation.mockResolvedValueOnce(row('confirmed'));

    await expect(hold(d)).resolves.toEqual({
      code: 'already_booked',
      reservation: row('confirmed'),
    });
    expect(d.counter.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('answers already_held when a concurrent hold of the same member won the insert', async () => {
    const d = doubles();
    d.m.insertHold.mockRejectedValueOnce(new UniqueViolationError());
    d.m.findOwnHold
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: HOLD_ID, expiresAt: HOLD.expiresAt, now: new Date(NOW) });

    await expect(hold(d)).resolves.toEqual({ code: 'already_held', hold: HOLD });
  });

  it('refuses a stale classVersion before the counter, and under the lock after it', async () => {
    const early = doubles();
    await expect(hold(early, { classVersion: CLASS.version - 1 })).resolves.toEqual({
      code: 'class_changed',
    });
    expect(early.counter.decrRemainingOrInit).not.toHaveBeenCalled();

    const late = doubles();
    late.m.lockClassForBooking.mockResolvedValueOnce({
      startsAt: CLASS.startsAt,
      now: new Date(NOW),
      version: CLASS.version + 1,
    });
    await expect(hold(late, { classVersion: CLASS.version })).resolves.toEqual({
      code: 'class_changed',
    });
    expect(late.m.insertHold).not.toHaveBeenCalled();
    expect(late.counter.incrRemaining).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
  });

  it('maps a missing or started class like a booking', async () => {
    const missing = doubles();
    missing.m.findClass.mockResolvedValueOnce(null);
    await expect(hold(missing)).resolves.toEqual({ code: 'class_not_found' });

    const started = doubles();
    started.m.findClass.mockResolvedValueOnce({ ...CLASS, startsAt: new Date(NOW) });
    await expect(hold(started)).resolves.toEqual({ code: 'class_in_past' });
    expect(started.counter.decrRemainingOrInit).not.toHaveBeenCalled();
  });

  it('answers counter_unavailable when Redis is down', async () => {
    const d = doubles();
    d.counter.decrRemainingOrInit.mockRejectedValueOnce(new Error('redis down'));
    await expect(hold(d)).resolves.toEqual({ code: 'counter_unavailable' });
  });
});

describe('confirmHold', () => {
  function confirm(d: ReturnType<typeof doubles>): ReturnType<typeof confirmHold> {
    return confirmHold({
      reservationId: HOLD_ID,
      userId: USER_ID,
      studioId: STUDIO_ID,
      repo: d.repo,
      publisher: d.publisher,
    });
  }

  it('confirms an active hold with one reservation.created event in the same transaction', async () => {
    const d = doubles();
    d.m.findReservationForUpdate.mockResolvedValueOnce(row('pending'));
    d.m.confirmHold.mockResolvedValueOnce(row('confirmed'));

    await expect(confirm(d)).resolves.toEqual({
      code: 'confirmed',
      reservation: row('confirmed'),
    });
    expect(d.m.confirmHold).toHaveBeenCalledExactlyOnceWith(d.txs[0], HOLD_ID);
    expect(d.m.insertOutbox).toHaveBeenCalledExactlyOnceWith(d.txs[0], CREATED);
  });

  it('refuses to confirm a hold once the class started', async () => {
    const d = doubles();
    d.m.findReservationForUpdate.mockResolvedValueOnce(row('pending'));
    d.m.readClassClock.mockResolvedValueOnce({
      startsAt: new Date(NOW - 60_000),
      now: new Date(NOW),
    });

    await expect(confirm(d)).resolves.toEqual({ code: 'class_in_past' });
    expect(d.m.confirmHold).not.toHaveBeenCalled();
  });

  it('answers hold_expired when the trigger refuses an expired hold', async () => {
    const d = doubles();
    d.m.findReservationForUpdate.mockResolvedValueOnce(row('pending'));
    d.m.confirmHold.mockRejectedValueOnce(new HoldExpiredError());

    await expect(confirm(d)).resolves.toEqual({ code: 'hold_expired' });
    expect(d.m.insertOutbox).not.toHaveBeenCalled();
  });

  it('replays a confirmed reservation without a second event', async () => {
    const d = doubles();
    d.m.findReservationForUpdate.mockResolvedValueOnce(row('confirmed'));

    await expect(confirm(d)).resolves.toEqual({
      code: 'already_confirmed',
      reservation: row('confirmed'),
    });
    expect(d.m.confirmHold).not.toHaveBeenCalled();
    expect(d.m.insertOutbox).not.toHaveBeenCalled();
  });

  it('maps a released, waitlist or unknown reservation', async () => {
    const released = doubles();
    released.m.findReservationForUpdate.mockResolvedValueOnce(row('cancelled'));
    await expect(confirm(released)).resolves.toEqual({ code: 'hold_expired' });

    const waiter = doubles();
    waiter.m.findReservationForUpdate.mockResolvedValueOnce(row('waitlist'));
    await expect(confirm(waiter)).resolves.toEqual({ code: 'not_a_hold' });

    const missing = doubles();
    missing.m.findReservationForUpdate.mockResolvedValueOnce(null);
    await expect(confirm(missing)).resolves.toEqual({ code: 'not_found' });
  });
});
