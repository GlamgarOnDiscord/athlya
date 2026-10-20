import { describe, expect, it } from 'vitest';

import {
  capacityView,
  groupByDay,
  initialSelection,
  localDayKey,
  nextDayWithClasses,
  weekDays,
} from './schedule';

const NOW = new Date(2026, 9, 20, 9, 15);

function at(dayOffset: number, hour: number): string {
  return new Date(2026, 9, 20 + dayOffset, hour).toISOString();
}

describe('localDayKey / weekDays', () => {
  it('formats the local date', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('lists seven local days from today, then the following week', () => {
    expect(weekDays(NOW, 0).map(localDayKey)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(localDayKey(weekDays(NOW, 1)[0] as Date)).toBe('2026-10-27');
    expect(localDayKey(weekDays(new Date(2026, 11, 29), 0)[6] as Date)).toBe('2027-01-04');
  });
});

describe('groupByDay', () => {
  it('groups by local day, each group in start order', () => {
    const groups = groupByDay([
      { id: 'b', startsAt: at(1, 18) },
      { id: 'c', startsAt: at(0, 19) },
      { id: 'a', startsAt: at(1, 7) },
    ]);
    expect([...groups.keys()]).toEqual(['2026-10-20', '2026-10-21']);
    expect(groups.get('2026-10-21')?.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('initialSelection / nextDayWithClasses', () => {
  it('opens on the first day with a class, in the second week if needed', () => {
    expect(initialSelection(NOW, groupByDay([{ startsAt: at(2, 9) }]))).toEqual({
      weekOffset: 0,
      dayKey: '2026-10-22',
    });
    expect(initialSelection(NOW, groupByDay([{ startsAt: at(9, 9) }]))).toEqual({
      weekOffset: 1,
      dayKey: '2026-10-29',
    });
  });

  it('falls back to today when no shown day has a class', () => {
    expect(initialSelection(NOW, new Map())).toEqual({ weekOffset: 0, dayKey: '2026-10-20' });
  });

  it('finds the next day with a class after the given one', () => {
    const groups = groupByDay([{ startsAt: at(0, 9) }, { startsAt: at(8, 9) }]);
    expect(nextDayWithClasses(NOW, '2026-10-21', groups)).toEqual({
      weekOffset: 1,
      dayKey: '2026-10-28',
    });
    expect(nextDayWithClasses(NOW, '2026-10-28', groups)).toBeNull();
  });
});

describe('capacityView', () => {
  it('counts the seats taken, which the bar and its text both show', () => {
    expect(capacityView(12, 4)).toEqual({
      taken: 8,
      capacity: 12,
      remaining: 4,
      ratio: 8 / 12,
      full: false,
    });
  });

  it('reads an empty class as 0 and a full one as 1', () => {
    expect(capacityView(20, 20).ratio).toBe(0);
    expect(capacityView(20, 0)).toMatchObject({ taken: 20, ratio: 1, full: true });
  });

  it('clamps a remaining count outside 0..capacity', () => {
    expect(capacityView(10, -2)).toMatchObject({ taken: 10, remaining: 0, full: true });
    expect(capacityView(10, 14)).toMatchObject({ taken: 0, remaining: 10, ratio: 0 });
  });
});
