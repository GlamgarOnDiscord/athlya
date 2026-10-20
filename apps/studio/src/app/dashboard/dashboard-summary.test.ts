import { describe, expect, it } from 'vitest';

import {
  bookedSeats,
  classTiming,
  overviewRange,
  summarize,
  type OverviewClass,
} from './dashboard-summary';

/** Tuesday 20 October 2026, 15:00 local time. */
const NOW = new Date(2026, 9, 20, 15, 0);

let seq = 0;
function cls(day: number, hour: number, capacity: number, remaining: number): OverviewClass {
  seq += 1;
  return {
    id: `0c000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    title: 'Yoga Vinyasa',
    startsAt: new Date(2026, 9, day, hour, 0).toISOString(),
    durationMin: 60,
    capacity,
    remaining,
  };
}

describe('overviewRange', () => {
  it('starts on the Monday of the current week and spans two weeks', () => {
    const { from, to } = overviewRange(NOW);
    expect(from).toEqual(new Date(2026, 9, 19));
    expect(to).toEqual(new Date(2026, 10, 2));
  });
});

describe('bookedSeats', () => {
  it('is capacity minus remaining, never negative', () => {
    expect(bookedSeats(cls(20, 9, 12, 3))).toBe(9);
    expect(bookedSeats(cls(20, 9, 12, 14))).toBe(0);
  });
});

describe('classTiming', () => {
  it('tells done, live and later classes apart', () => {
    expect(classTiming(cls(20, 13, 10, 0), NOW)).toBe('done');
    expect(classTiming(cls(20, 14, 10, 0), NOW)).toBe('done');
    expect(classTiming({ ...cls(20, 14, 10, 0), durationMin: 90 }, NOW)).toBe('live');
    expect(classTiming(cls(20, 18, 10, 0), NOW)).toBe('later');
  });
});

describe('summarize', () => {
  it("keeps today's classes in time order, past ones included", () => {
    const evening = cls(20, 18, 10, 2);
    const morning = cls(20, 7, 10, 5);
    const summary = summarize([evening, cls(21, 7, 10, 0), morning], NOW);
    expect(summary.today.map((c) => c.id)).toEqual([morning.id, evening.id]);
  });

  it('computes the fill rate of the Monday to Sunday week only', () => {
    const summary = summarize(
      [cls(19, 7, 10, 5), cls(25, 10, 10, 0), cls(26, 7, 20, 20), cls(18, 7, 20, 0)],
      NOW,
    );
    expect(summary.week).toEqual({ classes: 2, booked: 15, capacity: 20, percent: 75 });
  });

  it('reports no fill rate for a week without seats', () => {
    expect(summarize([], NOW).week.percent).toBeNull();
  });

  it('lists upcoming classes from tomorrow on, capped', () => {
    const later = Array.from({ length: 7 }, (_, i) => cls(22 + i, 9, 10, 1));
    const summary = summarize([cls(20, 20, 10, 1), ...later], NOW);
    expect(summary.upcoming).toHaveLength(5);
    expect(summary.upcoming[0]?.id).toBe(later[0]?.id);
  });
});
