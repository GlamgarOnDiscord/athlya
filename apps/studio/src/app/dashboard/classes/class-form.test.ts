/**
 * Helpers of the class dialog (issue #748): weekly repeat defaults and
 * toggles, the series request, the 409 `schedule_conflict` reader and the
 * room filter.
 */
import { describe, expect, it } from 'vitest';

import {
  defaultRepeat,
  inRoom,
  isoWeekdayOfLocal,
  localTimeOf,
  problemCodeOf,
  recurrenceOf,
  scheduleConflictsOf,
  toggleWeekday,
} from './class-form';

const CONFLICT = {
  occurrenceStartsAt: '2099-01-05T09:00:00.000Z',
  classId: '0c510000-0000-4000-8000-000000000001',
  title: 'Yoga',
  startsAt: '2099-01-05T08:30:00.000Z',
  durationMin: 60,
  reasons: ['room', 'coach'],
};

describe('repeat', () => {
  it('starts off, on the weekday of the start, for eight classes', () => {
    expect(isoWeekdayOfLocal('2026-10-25T09:00')).toBe(7);
    expect(defaultRepeat('2026-10-19T09:00')).toEqual({
      enabled: false,
      weekdays: [1],
      end: 'count',
      count: '8',
      until: '',
    });
    expect(defaultRepeat('').weekdays).toEqual([]);
  });

  it('toggles a weekday and keeps the days in order', () => {
    expect(toggleWeekday([3], 1)).toEqual([1, 3]);
    expect(toggleWeekday([1, 3], 3)).toEqual([1]);
  });

  it('sends the count or the last day, never both', () => {
    const base = defaultRepeat('2026-10-19T09:00');
    expect(recurrenceOf({ ...base, weekdays: [1, 4], count: '10' })).toEqual({
      weekdays: [1, 4],
      count: 10,
    });
    expect(recurrenceOf({ ...base, end: 'until', until: '2026-12-21' })).toEqual({
      weekdays: [1],
      until: '2026-12-21',
    });
    expect(localTimeOf('2026-10-19T18:45')).toBe('18:45');
  });
});

describe('scheduleConflictsOf', () => {
  it('reads the clashes of a 409 schedule_conflict', () => {
    const err = {
      status: 409,
      problem: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'taken',
        code: 'schedule_conflict',
        conflicts: [CONFLICT],
      },
    };
    expect(scheduleConflictsOf(err)).toEqual([CONFLICT]);
    expect(problemCodeOf(err)).toBe('schedule_conflict');
  });

  it('ignores any other error', () => {
    const versionConflict = {
      status: 409,
      problem: { type: 'about:blank', title: 'Conflict', status: 409, code: 'version_conflict' },
    };
    expect(scheduleConflictsOf(versionConflict)).toBeNull();
    expect(problemCodeOf(versionConflict)).toBe('version_conflict');
    expect(scheduleConflictsOf(new Error('network'))).toBeNull();
    expect(problemCodeOf(null)).toBeUndefined();
  });
});

describe('inRoom', () => {
  const items = [{ id: 'a', roomId: 'r1' }, { id: 'b', roomId: null }, { id: 'c' }];

  it('keeps every class without a filter, the room ones with it', () => {
    expect(inRoom(items, null)).toHaveLength(3);
    expect(inRoom(items, 'r1').map((i) => i.id)).toEqual(['a']);
  });
});
