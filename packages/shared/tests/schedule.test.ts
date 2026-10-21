/**
 * Examples for the planning helpers and schemas of issue #748: wall-clock
 * time across DST, weekly expansion edges, conflict reasons, and the room
 * and series request schemas.
 */

import { describe, expect, it } from 'vitest';

import {
  expandWeeklySeries,
  findScheduleConflicts,
  retimeInZone,
  zonedTimeToUtc,
} from '../src/schedule.js';
import {
  CreateClassSeriesRequestSchema,
  CreateRoomRequestSchema,
  UpdateClassRequestSchema,
  UpdateClassSeriesRequestSchema,
  UpdateRoomRequestSchema,
} from '../src/schemas/api.js';

const iso = (dates: ReadonlyArray<Date>): string[] => dates.map((d) => d.toISOString());

describe('zoned time', () => {
  it('maps Paris wall-clock time to UTC on both sides of the spring DST change', () => {
    const before = zonedTimeToUtc(
      { year: 2027, month: 3, day: 27, hour: 9, minute: 0 },
      'Europe/Paris',
    );
    const after = zonedTimeToUtc(
      { year: 2027, month: 3, day: 29, hour: 9, minute: 0 },
      'Europe/Paris',
    );
    expect(before.toISOString()).toBe('2027-03-27T08:00:00.000Z');
    expect(after.toISOString()).toBe('2027-03-29T07:00:00.000Z');
  });

  it('moves a time skipped by DST one hour later', () => {
    const skipped = zonedTimeToUtc(
      { year: 2027, month: 3, day: 28, hour: 2, minute: 30 },
      'Europe/Paris',
    );
    expect(skipped.toISOString()).toBe('2027-03-28T01:30:00.000Z');
  });

  it('takes the first reading of a time repeated by the autumn change', () => {
    const repeated = zonedTimeToUtc(
      { year: 2027, month: 10, day: 31, hour: 2, minute: 30 },
      'Europe/Paris',
    );
    expect(repeated.toISOString()).toBe('2027-10-31T00:30:00.000Z');
  });

  it('retimes an instant on its own local day', () => {
    const moved = retimeInZone(new Date('2027-01-04T23:30:00Z'), '07:15', 'America/New_York');
    expect(moved.toISOString()).toBe('2027-01-04T12:15:00.000Z');
  });
});

describe('expandWeeklySeries', () => {
  it('keeps 09:00 Paris time across the DST change, for a count', () => {
    const result = expandWeeklySeries({
      firstStart: new Date('2027-03-22T08:00:00Z'),
      weekdays: [1],
      count: 3,
      timeZone: 'Europe/Paris',
    });
    expect(result.ok && iso(result.occurrences)).toEqual([
      '2027-03-22T08:00:00.000Z',
      '2027-03-29T07:00:00.000Z',
      '2027-04-05T07:00:00.000Z',
    ]);
  });

  it('skips the first day when its weekday is not chosen, and stops at until (inclusive)', () => {
    const result = expandWeeklySeries({
      firstStart: new Date('2027-01-05T18:00:00Z'),
      weekdays: [1, 4],
      until: '2027-01-11',
      timeZone: 'UTC',
    });
    expect(result.ok && iso(result.occurrences)).toEqual([
      '2027-01-07T18:00:00.000Z',
      '2027-01-11T18:00:00.000Z',
    ]);
  });

  it('refuses an empty rule and one past the cap', () => {
    expect(
      expandWeeklySeries({
        firstStart: new Date('2027-01-05T18:00:00Z'),
        weekdays: [1],
        until: '2027-01-05',
        timeZone: 'UTC',
      }),
    ).toEqual({ ok: false, reason: 'no_occurrences' });
    expect(
      expandWeeklySeries({
        firstStart: new Date('2027-01-04T18:00:00Z'),
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        until: '2027-12-31',
        timeZone: 'UTC',
      }),
    ).toEqual({ ok: false, reason: 'too_many_occurrences' });
  });
});

describe('findScheduleConflicts', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2027, 0, 4, h, m));
  const existing = [
    { id: 'a', title: 'Yoga', startsAt: at(9), durationMin: 60, roomId: 'r1', coachId: 'c1' },
    { id: 'b', title: 'Spin', startsAt: at(10), durationMin: 45, roomId: 'r2', coachId: null },
  ];

  it('names the shared room, the shared coach, or both', () => {
    const conflicts = findScheduleConflicts(
      [
        { startsAt: at(9, 30), durationMin: 60, roomId: 'r1', coachId: null },
        { startsAt: at(9, 30), durationMin: 60, roomId: 'r2', coachId: 'c1' },
      ],
      existing,
    );
    expect(conflicts.map((c) => [c.candidate, c.existing.id, c.reasons])).toEqual([
      [0, 'a', ['room']],
      [1, 'a', ['coach']],
      [1, 'b', ['room']],
    ]);
  });

  it('ignores back-to-back classes, no shared resource and ignored ids', () => {
    expect(
      findScheduleConflicts(
        [{ startsAt: at(10), durationMin: 30, roomId: 'r1', coachId: 'c1' }],
        existing,
      ),
    ).toEqual([]);
    expect(
      findScheduleConflicts(
        [{ startsAt: at(9), durationMin: 30, roomId: null, coachId: null }],
        existing,
      ),
    ).toEqual([]);
    expect(
      findScheduleConflicts(
        [{ startsAt: at(9), durationMin: 30, roomId: 'r1', coachId: null }],
        existing,
        new Set(['a']),
      ),
    ).toEqual([]);
  });
});

describe('room and series schemas', () => {
  it('rooms: trimmed name of 1 to 80, optional capacity 1 to 500 or null', () => {
    expect(CreateRoomRequestSchema.parse({ name: ' Mat ' })).toEqual({ name: 'Mat' });
    expect(CreateRoomRequestSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(CreateRoomRequestSchema.safeParse({ name: 'A', capacity: 501 }).success).toBe(false);
    expect(UpdateRoomRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateRoomRequestSchema.parse({ capacity: null })).toEqual({ capacity: null });
  });

  it('a class patch may move only the room', () => {
    expect(UpdateClassRequestSchema.safeParse({ roomId: null, version: 0 }).success).toBe(true);
    expect(UpdateClassRequestSchema.safeParse({ allowConflicts: true, version: 0 }).success).toBe(
      false,
    );
  });

  it('series: one of until and count, a known time zone, startTime with its zone', () => {
    const base = {
      title: 'Flow',
      startsAt: '2027-01-04T09:00:00.000Z',
      durationMin: 60,
      capacity: 10,
      timeZone: 'Europe/Paris',
    };
    expect(
      CreateClassSeriesRequestSchema.safeParse({ ...base, recurrence: { weekdays: [1], count: 2 } })
        .success,
    ).toBe(true);
    expect(
      CreateClassSeriesRequestSchema.safeParse({ ...base, recurrence: { weekdays: [1], count: 1 } })
        .success,
    ).toBe(false);
    expect(
      CreateClassSeriesRequestSchema.safeParse({
        ...base,
        timeZone: 'Nowhere/Land',
        recurrence: { weekdays: [1], count: 2 },
      }).success,
    ).toBe(false);
    const anchor = { fromClassId: '0c510000-0000-4000-8000-000000000001', version: 0 };
    expect(
      UpdateClassSeriesRequestSchema.safeParse({ ...anchor, startTime: '08:00' }).success,
    ).toBe(false);
    expect(
      UpdateClassSeriesRequestSchema.safeParse({ ...anchor, startTime: '08:00', timeZone: 'UTC' })
        .success,
    ).toBe(true);
  });
});
