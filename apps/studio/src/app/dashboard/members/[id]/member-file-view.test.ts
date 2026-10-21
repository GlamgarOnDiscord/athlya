import { describe, expect, it } from 'vitest';

import { pastOutcome, upcomingOutcome } from './member-file-view';

import type { MemberFileReservation } from '@athlya/shared/schemas/api';

const reservation = (
  status: MemberFileReservation['status'],
  checkedInAt: string | null = null,
): MemberFileReservation => ({
  id: 'r1',
  status,
  bookedAt: '2030-01-01T08:00:00.000Z',
  cancelledAt: status === 'cancelled' ? '2030-01-01T08:30:00.000Z' : null,
  checkedInAt,
  class: { id: 'c1', title: 'Hyrox', startsAt: '2030-01-01T09:00:00.000Z', durationMin: 60 },
});

describe('pastOutcome', () => {
  it('reads presence first, then the status', () => {
    expect(pastOutcome(reservation('confirmed', '2030-01-01T08:58:00.000Z'))).toBe('attended');
    expect(pastOutcome(reservation('confirmed'))).toBe('missed');
    expect(pastOutcome(reservation('no_show'))).toBe('no_show');
    expect(pastOutcome(reservation('cancelled'))).toBe('cancelled');
    expect(pastOutcome(reservation('waitlist'))).toBe('waitlist');
  });
});

describe('upcomingOutcome', () => {
  it('is booked or waitlisted, or present when already checked in', () => {
    expect(upcomingOutcome(reservation('confirmed'))).toBe('confirmed');
    expect(upcomingOutcome(reservation('waitlist'))).toBe('waitlist');
    expect(upcomingOutcome(reservation('confirmed', '2030-01-01T08:40:00.000Z'))).toBe('attended');
  });
});
