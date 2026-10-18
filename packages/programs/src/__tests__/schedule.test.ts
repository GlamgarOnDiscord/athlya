import { describe, expect, it } from 'vitest';

import {
  addDays,
  daysBetween,
  isLocalDate,
  resolveScheduleDay,
  resolveTodayItem,
  utcDate,
} from '../schedule.js';

import { makeProgram, makeSubscription } from './fixtures.js';

describe('calendar helpers', () => {
  it('validates real calendar dates only', () => {
    expect(isLocalDate('2026-02-28')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-01')).toBe(false);
    expect(isLocalDate('not a date')).toBe(false);
  });

  it('counts whole days across months, years and DST changes', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-01-10', '2026-01-03')).toBe(-7);
  });

  it('adds days and formats the UTC date', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(utcDate(new Date('2026-10-18T23:30:00.000Z'))).toBe('2026-10-18');
  });

  it('rejects an invalid date instead of guessing', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(RangeError);
  });
});

describe('resolveScheduleDay', () => {
  it('maps the start date to week 1 day 1 and counts days from it', () => {
    expect(resolveScheduleDay('2026-10-14', '2026-10-14', 4)).toEqual({
      status: 'active',
      weekNumber: 1,
      dayNumber: 1,
    });
    expect(resolveScheduleDay('2026-10-14', '2026-10-20', 4)).toEqual({
      status: 'active',
      weekNumber: 1,
      dayNumber: 7,
    });
    expect(resolveScheduleDay('2026-10-14', '2026-10-21', 4)).toEqual({
      status: 'active',
      weekNumber: 2,
      dayNumber: 1,
    });
  });

  it('is not started before the start date and completed after the last week', () => {
    expect(resolveScheduleDay('2026-10-14', '2026-10-13', 4)).toEqual({ status: 'not_started' });
    expect(resolveScheduleDay('2026-10-14', '2026-11-10', 4)).toEqual({
      status: 'active',
      weekNumber: 4,
      dayNumber: 7,
    });
    expect(resolveScheduleDay('2026-10-14', '2026-11-11', 4)).toEqual({ status: 'completed' });
  });
});

describe('resolveTodayItem', () => {
  const program = makeProgram({
    weeks: [
      {
        weekNumber: 1,
        title: null,
        workouts: [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            dayNumber: 1,
            title: 'Squat',
            notes: null,
            exercises: [{ name: 'Back squat', sets: 5, reps: 5 }],
          },
        ],
      },
      { weekNumber: 2, title: 'Deload', workouts: [] },
    ],
  });
  const schedule = { subscription: makeSubscription({ startsOn: '2026-10-12' }), program };

  it('returns the prescribed workout of the day', () => {
    const item = resolveTodayItem(schedule, '2026-10-12');
    expect(item).toMatchObject({
      status: 'scheduled',
      weekNumber: 1,
      dayNumber: 1,
      totalWeeks: 2,
      program: { id: program.id, title: program.title },
    });
    expect(item.workout?.title).toBe('Squat');
  });

  it('reports a rest day inside the program', () => {
    expect(resolveTodayItem(schedule, '2026-10-13')).toMatchObject({
      status: 'rest',
      weekNumber: 1,
      dayNumber: 2,
      workout: null,
    });
    expect(resolveTodayItem(schedule, '2026-10-19')).toMatchObject({
      status: 'rest',
      weekNumber: 2,
      dayNumber: 1,
    });
  });

  it('reports not started and completed without week or day', () => {
    expect(resolveTodayItem(schedule, '2026-10-11')).toMatchObject({
      status: 'not_started',
      weekNumber: null,
      dayNumber: null,
      workout: null,
    });
    expect(resolveTodayItem(schedule, '2026-10-26')).toMatchObject({
      status: 'completed',
      weekNumber: null,
      dayNumber: null,
    });
  });
});
