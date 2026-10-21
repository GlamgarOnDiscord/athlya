import { describe, expect, it } from 'vitest';

import { attendanceState, rosterStats, withEntry } from './roster-view';

import type { ClassRosterEntry, ClassRosterResponse } from '@athlya/shared/schemas/api';

const entry = (id: string, checkedInAt: string | null = null): ClassRosterEntry => ({
  reservationId: id,
  status: 'confirmed',
  bookedAt: '2030-01-01T08:00:00.000Z',
  checkedInAt,
  member: { id: `m-${id}`, displayName: id, avatarUrl: null },
});

const ROSTER: ClassRosterResponse = {
  class: {
    id: 'c1',
    title: 'Hyrox',
    startsAt: '2030-01-01T09:00:00.000Z',
    durationMin: 60,
    capacity: 3,
    coach: null,
  },
  confirmed: [entry('a', '2030-01-01T08:58:00.000Z'), entry('b')],
  waitlist: [{ ...entry('w'), status: 'waitlist' }],
  attendance: { opensAt: '2030-01-01T08:30:00.000Z', closesAt: '2030-01-02T10:00:00.000Z' },
};

describe('attendanceState', () => {
  it('is before, open, then closed', () => {
    expect(attendanceState(ROSTER.attendance, new Date('2030-01-01T08:29:00Z'))).toBe('before');
    expect(attendanceState(ROSTER.attendance, new Date('2030-01-01T08:30:00Z'))).toBe('open');
    expect(attendanceState(ROSTER.attendance, new Date('2030-01-02T10:00:00Z'))).toBe('open');
    expect(attendanceState(ROSTER.attendance, new Date('2030-01-02T10:01:00Z'))).toBe('closed');
  });
});

describe('rosterStats', () => {
  it('counts the booked, the present and the waiting', () => {
    expect(rosterStats(ROSTER)).toEqual({ booked: 2, checkedIn: 1, waitlist: 1 });
  });
});

describe('withEntry', () => {
  it('replaces the matching row and leaves the others', () => {
    const next = withEntry(ROSTER, entry('b', '2030-01-01T09:02:00.000Z'));
    expect(next.confirmed.map((e) => e.checkedInAt)).toEqual([
      '2030-01-01T08:58:00.000Z',
      '2030-01-01T09:02:00.000Z',
    ]);
    expect(next.waitlist).toEqual(ROSTER.waitlist);
    expect(rosterStats(next).checkedIn).toBe(2);
  });
});
