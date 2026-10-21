/**
 * Class roster and member file schemas (issue #746).
 */

import { describe, expect, it } from 'vitest';

import {
  ClassRosterResponseSchema,
  MEMBER_FILE_LIST_LIMIT,
  MemberFileResponseSchema,
  RosterCheckInParamsSchema,
} from '../src/schemas/api.js';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2030-01-01T09:00:00.000Z';
const PERSON = { id: ID, displayName: 'Ada', avatarUrl: null };

const ROSTER = {
  class: { id: ID, title: 'Hyrox', startsAt: AT, durationMin: 60, capacity: 12, coach: PERSON },
  confirmed: [
    { reservationId: ID, status: 'confirmed', bookedAt: AT, checkedInAt: null, member: PERSON },
  ],
  waitlist: [],
  attendance: { opensAt: AT, closesAt: AT },
};

const RESERVATION = {
  id: ID,
  status: 'no_show',
  bookedAt: AT,
  cancelledAt: null,
  checkedInAt: null,
  class: { id: ID, title: 'Hyrox', startsAt: AT, durationMin: 60 },
};

const FILE = {
  member: {
    id: ID,
    email: 'ada@example.com',
    displayName: 'Ada',
    avatarUrl: null,
    role: 'member',
    consents: {
      marketing: false,
      analytics: true,
      thirdParty: false,
      version: '2026-01',
      updatedAt: AT,
    },
    createdAt: AT,
  },
  upcoming: [],
  past: [RESERVATION],
  stats: { checkIns: 3, lastCheckInAt: AT, noShows: 1, cancellations: 0 },
};

describe('ClassRosterResponseSchema', () => {
  it('accepts a roster and keeps contact data out of a row', () => {
    expect(ClassRosterResponseSchema.safeParse(ROSTER).success).toBe(true);
    const withEmail = {
      ...ROSTER,
      confirmed: [{ ...ROSTER.confirmed[0], member: { ...PERSON, email: 'ada@example.com' } }],
    };
    expect(ClassRosterResponseSchema.safeParse(withEmail).success).toBe(false);
  });

  it('only lists confirmed or waitlisted rows', () => {
    const cancelled = { ...ROSTER, waitlist: [{ ...ROSTER.confirmed[0], status: 'cancelled' }] };
    expect(ClassRosterResponseSchema.safeParse(cancelled).success).toBe(false);
  });
});

describe('RosterCheckInParamsSchema', () => {
  it('needs two uuids', () => {
    expect(RosterCheckInParamsSchema.safeParse({ id: ID, reservationId: ID }).success).toBe(true);
    expect(RosterCheckInParamsSchema.safeParse({ id: ID, reservationId: 'x' }).success).toBe(false);
  });
});

describe('MemberFileResponseSchema', () => {
  it('accepts a member file', () => {
    expect(MemberFileResponseSchema.safeParse(FILE).success).toBe(true);
  });

  it('caps each list', () => {
    const tooMany = {
      ...FILE,
      past: Array.from({ length: MEMBER_FILE_LIST_LIMIT + 1 }, () => RESERVATION),
    };
    expect(MemberFileResponseSchema.safeParse(tooMany).success).toBe(false);
  });
});
