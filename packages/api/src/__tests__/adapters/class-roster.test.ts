/**
 * Rules of the class roster (issue #746) over an in-memory repo: who may
 * open it, how it is split, and when a manual check-in is refused.
 */

import { describe, expect, it, vi } from 'vitest';

import { CheckinStampRejectedError } from '../../adapters/checkins-deps.js';
import {
  ATTENDANCE_LATE_MS,
  attendanceWindow,
  canManageRoster,
  getRosterWith,
  markAttendanceWith,
  type RosterClass,
  type RosterRepo,
  type RosterRow,
} from '../../adapters/class-roster.js';

import type { AuthClaims } from '../../middleware/auth.js';

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COACH = '11111111-1111-4111-8111-11111111c0ac';
const OTHER_COACH = '11111111-1111-4111-8111-11111111c0ad';
const CLASS_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
const START = new Date('2030-01-01T09:00:00Z');

const claims = (role: AuthClaims['role'], userId = COACH): AuthClaims => ({
  userId,
  studioId: STUDIO,
  role,
});

const CLASS: RosterClass = {
  id: CLASS_ID,
  coachId: COACH,
  title: 'Hyrox',
  startsAt: START,
  durationMin: 60,
  capacity: 2,
  coach: { id: COACH, displayName: 'Coach', avatarUrl: null },
};

function row(id: string, status: RosterRow['status'], checkedInAt: Date | null = null): RosterRow {
  return {
    reservationId: id,
    status,
    bookedAt: new Date('2029-12-30T10:00:00Z'),
    checkedInAt,
    member: { id: `member-${id}`, displayName: `Member ${id}`, avatarUrl: null },
  };
}

function repoWith(rows: RosterRow[], cls: RosterClass | null = CLASS): RosterRepo {
  const state = new Map(rows.map((r) => [r.reservationId, r]));
  return {
    findClass: vi.fn(async () => cls),
    listRoster: vi.fn(async () => [...state.values()]),
    findEntry: vi.fn(async (_classId: string, id: string) => state.get(id) ?? null),
    markCheckedIn: vi.fn(async (id: string, at: Date) => {
      const current = state.get(id);
      if (current !== undefined) state.set(id, { ...current, checkedInAt: at });
    }),
  };
}

describe('canManageRoster', () => {
  it('admits the admin and the coach of the class only', () => {
    expect(canManageRoster(claims('admin', OTHER_COACH), CLASS)).toBe(true);
    expect(canManageRoster(claims('coach'), CLASS)).toBe(true);
    expect(canManageRoster(claims('coach', OTHER_COACH), CLASS)).toBe(false);
    expect(canManageRoster(claims('member'), CLASS)).toBe(false);
  });

  it('gives no coach a class without a coach', () => {
    expect(canManageRoster(claims('coach'), { coachId: null })).toBe(false);
  });
});

describe('attendanceWindow', () => {
  it('opens 30 minutes before the start and closes a day after the end', () => {
    const { opensAt, closesAt } = attendanceWindow(START, 60);
    expect(opensAt.toISOString()).toBe('2030-01-01T08:30:00.000Z');
    expect(closesAt.getTime()).toBe(START.getTime() + 60 * 60_000 + ATTENDANCE_LATE_MS);
  });
});

describe('getRosterWith', () => {
  it('splits confirmed and waitlist and drops other statuses', async () => {
    const repo = repoWith([
      row('a', 'confirmed'),
      row('b', 'waitlist'),
      row('c', 'cancelled'),
      row('d', 'confirmed', new Date('2030-01-01T08:55:00Z')),
    ]);

    const outcome = await getRosterWith(claims('coach'), CLASS_ID, repo);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.roster.confirmed.map((e) => e.reservationId)).toEqual(['a', 'd']);
    expect(outcome.roster.waitlist.map((e) => e.reservationId)).toEqual(['b']);
    expect(outcome.roster.confirmed[1]?.checkedInAt).toBe('2030-01-01T08:55:00.000Z');
    expect(outcome.roster.attendance.opensAt).toBe('2030-01-01T08:30:00.000Z');
    expect(outcome.roster.class.coach).toEqual(CLASS.coach);
  });

  it('reads no reservation for a coach of another class', async () => {
    const repo = repoWith([row('a', 'confirmed')]);
    const outcome = await getRosterWith(claims('coach', OTHER_COACH), CLASS_ID, repo);
    expect(outcome).toEqual({ kind: 'forbidden' });
    expect(repo.listRoster).not.toHaveBeenCalled();
  });

  it('answers not_found for an unknown class', async () => {
    const outcome = await getRosterWith(claims('admin'), CLASS_ID, repoWith([], null));
    expect(outcome).toEqual({ kind: 'not_found' });
  });
});

describe('markAttendanceWith', () => {
  const at = (iso: string) => () => Date.parse(iso);

  it('stamps a confirmed member inside the window and returns the entry', async () => {
    const repo = repoWith([row('a', 'confirmed')]);
    const outcome = await markAttendanceWith(claims('coach'), CLASS_ID, 'a', {
      repo,
      now: at('2030-01-01T09:05:00Z'),
    });
    expect(outcome).toMatchObject({
      kind: 'checked_in',
      entry: { reservationId: 'a', checkedInAt: '2030-01-01T09:05:00.000Z' },
    });
  });

  it.each([
    ['too early', '2030-01-01T08:29:00Z'],
    ['too late', '2030-01-02T10:01:00Z'],
  ])('refuses %s with outside_window', async (_label, iso) => {
    const repo = repoWith([row('a', 'confirmed')]);
    const outcome = await markAttendanceWith(claims('admin'), CLASS_ID, 'a', {
      repo,
      now: at(iso),
    });
    expect(outcome).toEqual({ kind: 'fail', reason: 'outside_window' });
    expect(repo.markCheckedIn).not.toHaveBeenCalled();
  });

  it('refuses a waitlisted member and one already checked in', async () => {
    const repo = repoWith([row('w', 'waitlist'), row('d', 'confirmed', START)]);
    const ports = { repo, now: at('2030-01-01T09:05:00Z') };
    expect(await markAttendanceWith(claims('admin'), CLASS_ID, 'w', ports)).toEqual({
      kind: 'fail',
      reason: 'not_confirmed',
    });
    expect(await markAttendanceWith(claims('admin'), CLASS_ID, 'd', ports)).toEqual({
      kind: 'fail',
      reason: 'already_checked_in',
    });
  });

  it('refuses a coach of another class and an unknown reservation', async () => {
    const repo = repoWith([row('a', 'confirmed')]);
    const ports = { repo, now: at('2030-01-01T09:05:00Z') };
    expect(await markAttendanceWith(claims('coach', OTHER_COACH), CLASS_ID, 'a', ports)).toEqual({
      kind: 'forbidden',
    });
    expect(await markAttendanceWith(claims('admin'), CLASS_ID, 'zz', ports)).toEqual({
      kind: 'not_found',
    });
  });

  it.each([
    ['checkin_limit_reached', 'checkin_limit_reached'],
    ['already_checked_in', 'already_checked_in'],
    ['no_reservation', 'not_confirmed'],
  ] as const)('maps a %s stamp rejection to %s', async (rejection, reason) => {
    const repo = repoWith([row('a', 'confirmed')]);
    vi.mocked(repo.markCheckedIn).mockRejectedValueOnce(new CheckinStampRejectedError(rejection));
    const outcome = await markAttendanceWith(claims('admin'), CLASS_ID, 'a', {
      repo,
      now: at('2030-01-01T09:05:00Z'),
    });
    expect(outcome).toEqual({ kind: 'fail', reason });
  });
});
