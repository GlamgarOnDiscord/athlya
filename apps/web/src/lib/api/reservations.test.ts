import { describe, expect, it, vi } from 'vitest';

import {
  bookingsByClass,
  canCancel,
  cancelReservationPath,
  fetchMyReservations,
  MAX_RESERVATION_PAGES,
  myReservationsPath,
  runningFrom,
  upcomingReservations,
  type MyReservation,
} from './reservations';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function reservation(
  id: string,
  startsAt: string,
  status: MyReservation['status'] = 'confirmed',
  durationMin = 60,
): MyReservation {
  return {
    id,
    classId: `class-${id}`,
    status,
    class: { title: `Class ${id}`, startsAt, durationMin },
  };
}

describe('paths', () => {
  it('builds the list query with the range, page size and cursor', () => {
    const path = myReservationsPath({ from: NOW, to: new Date('2026-11-03T00:00:00.000Z') }, 'abc');
    const url = new URL(path, 'https://api.test');
    expect(url.pathname).toBe('/v1/reservations/me');
    expect(url.searchParams.get('from')).toBe(NOW.toISOString());
    expect(url.searchParams.get('to')).toBe('2026-11-03T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(
      new URL(myReservationsPath({ from: NOW }), 'https://api.test').searchParams.has('to'),
    ).toBe(false);
  });

  it('encodes the reservation id of a cancel', () => {
    expect(cancelReservationPath('a/b')).toBe('/v1/reservations/a%2Fb');
  });

  it('starts the running window one maximal class length back', () => {
    expect(runningFrom(NOW).toISOString()).toBe('2026-10-20T02:00:00.000Z');
  });
});

describe('fetchMyReservations', () => {
  it('follows the cursor and stops on the last page', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        items: [reservation('1', '2026-10-21T08:00:00.000Z')],
        nextCursor: 'n',
      })
      .mockResolvedValueOnce({
        items: [reservation('2', '2026-10-22T08:00:00.000Z')],
        nextCursor: null,
      });

    const items = await fetchMyReservations({ get }, { from: NOW });

    expect(items.map((item) => item.id)).toEqual(['1', '2']);
    expect(get).toHaveBeenCalledTimes(2);
    expect(String(get.mock.calls[1]?.[0])).toContain('cursor=n');
  });

  it('stops after the page bound', async () => {
    const get = vi.fn().mockResolvedValue({ items: [], nextCursor: 'again' });
    await fetchMyReservations({ get }, { from: NOW });
    expect(get).toHaveBeenCalledTimes(MAX_RESERVATION_PAGES);
  });

  it('rejects a body that is not a reservation page', async () => {
    const get = vi.fn().mockResolvedValue({ items: [{ id: 1 }] });
    await expect(fetchMyReservations({ get }, { from: NOW })).rejects.toThrow();
  });
});

describe('upcomingReservations', () => {
  it('keeps active reservations whose class has not ended, soonest first', () => {
    const items = [
      reservation('later', '2026-10-22T08:00:00.000Z'),
      reservation('running', '2026-10-20T09:30:00.000Z'),
      reservation('ended', '2026-10-20T08:00:00.000Z'),
      reservation('cancelled', '2026-10-21T08:00:00.000Z', 'cancelled'),
      reservation('waitlist', '2026-10-21T08:00:00.000Z', 'waitlist'),
    ];
    expect(upcomingReservations(items, NOW).map((item) => item.id)).toEqual([
      'running',
      'waitlist',
      'later',
    ]);
  });
});

describe('canCancel', () => {
  it('allows a cancel only more than 2 h before the start', () => {
    expect(canCancel(reservation('a', '2026-10-20T12:01:00.000Z'), NOW)).toBe(true);
    expect(canCancel(reservation('b', '2026-10-20T12:00:00.000Z'), NOW)).toBe(false);
    expect(canCancel(reservation('c', '2026-10-20T11:00:00.000Z'), NOW)).toBe(false);
  });

  it('refuses a reservation that is no longer active', () => {
    expect(canCancel(reservation('d', '2026-10-25T08:00:00.000Z', 'cancelled'), NOW)).toBe(false);
    expect(canCancel(reservation('e', '2026-10-25T08:00:00.000Z', 'waitlist'), NOW)).toBe(true);
  });
});

describe('bookingsByClass', () => {
  it('maps the active reservations by class', () => {
    const map = bookingsByClass([
      reservation('1', '2026-10-21T08:00:00.000Z'),
      reservation('2', '2026-10-21T08:00:00.000Z', 'waitlist'),
      reservation('3', '2026-10-21T08:00:00.000Z', 'cancelled'),
    ]);
    expect(map.get('class-1')).toEqual({ kind: 'confirmed', reservationId: '1' });
    expect(map.get('class-2')).toEqual({ kind: 'waitlist' });
    expect(map.has('class-3')).toBe(false);
  });
});
