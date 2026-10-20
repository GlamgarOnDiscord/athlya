import { describe, expect, it } from 'vitest';

import {
  bookedSeats,
  classTiming,
  minutesUntil,
  newMembersPerWeek,
  overviewRanges,
  periodStats,
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

describe('overviewRanges', () => {
  it('splits twelve past weeks and the current two at the Monday of this week', () => {
    const { history, current } = overviewRanges(NOW);
    expect(history.from).toEqual(new Date(2026, 6, 27));
    expect(history.to).toEqual(new Date(2026, 9, 19));
    expect(current.from).toEqual(new Date(2026, 9, 19));
    expect(current.to).toEqual(new Date(2026, 10, 2));
  });
});

describe('bookedSeats and classTiming', () => {
  it('is capacity minus remaining, never negative', () => {
    expect(bookedSeats(cls(20, 9, 12, 3))).toBe(9);
    expect(bookedSeats(cls(20, 9, 12, 14))).toBe(0);
  });

  it('tells done, live and later classes apart', () => {
    expect(classTiming(cls(20, 14, 10, 0), NOW)).toBe('done');
    expect(classTiming({ ...cls(20, 14, 10, 0), durationMin: 90 }, NOW)).toBe('live');
    expect(classTiming(cls(20, 18, 10, 0), NOW)).toBe('later');
  });
});

describe('periodStats', () => {
  it('reports no fill rate for a period without seats', () => {
    expect(periodStats([], NOW, NOW).percent).toBeNull();
  });
});

describe('summarize', () => {
  it("keeps today's classes in time order and finds the next one", () => {
    const evening = cls(20, 18, 10, 2);
    const morning = cls(20, 7, 10, 5);
    const summary = summarize([evening, cls(21, 7, 10, 0), morning], NOW);
    expect(summary.today.map((c) => c.id)).toEqual([morning.id, evening.id]);
    expect(summary.next?.id).toBe(evening.id);
  });

  it('compares the Monday to Sunday week with the previous one', () => {
    const summary = summarize(
      [cls(19, 7, 10, 5), cls(25, 10, 10, 0), cls(26, 7, 20, 20), cls(18, 7, 20, 0)],
      NOW,
    );
    expect(summary.week).toEqual({ classes: 2, booked: 15, capacity: 20, percent: 75 });
    expect(summary.previousWeek).toEqual({ classes: 1, booked: 20, capacity: 20, percent: 100 });
    expect(summary.hasHistory).toBe(true);
  });

  it('builds the daily series and the same-weekday comparison', () => {
    const summary = summarize([cls(13, 9, 10, 4), cls(13, 18, 10, 4), cls(20, 9, 10, 1)], NOW);
    expect(summary.sameDayLastWeek).toBe(2);
    expect(summary.classesTrend).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(summary.bookingsByDay).toEqual([0, 9, 0, 0, 0, 0, 0]);
    expect(summary.fillTrend.at(-1)).toBe(90);
    expect(summary.fillTrend.at(-2)).toBe(60);
    expect(summary.bookingsTrend.slice(-2)).toEqual([12, 9]);
  });

  it('has no history when every class is in the current week', () => {
    expect(summarize([cls(20, 9, 10, 1)], NOW).hasHistory).toBe(false);
  });

  it('lists the classes of the next seven days that have not started, capped', () => {
    const later = Array.from({ length: 10 }, (_, i) => cls(21 + (i % 5), 9 + i, 10, 1));
    const summary = summarize([cls(20, 9, 10, 1), cls(30, 9, 10, 1), ...later], NOW);
    expect(summary.upcoming).toHaveLength(8);
    expect(summary.upcoming.every((c) => new Date(c.startsAt) > NOW)).toBe(true);
  });
});

describe('minutesUntil', () => {
  it('counts whole minutes and never goes negative', () => {
    expect(minutesUntil(new Date(2026, 9, 20, 17, 5, 30).toISOString(), NOW)).toBe(125);
    expect(minutesUntil(new Date(2026, 9, 20, 14, 0).toISOString(), NOW)).toBe(0);
  });
});

describe('newMembersPerWeek', () => {
  it('counts sign-ups per Monday to Sunday week, current week last', () => {
    const joined = [
      new Date(2026, 9, 19, 8).toISOString(),
      new Date(2026, 9, 20, 8).toISOString(),
      new Date(2026, 9, 14, 8).toISOString(),
      new Date(2026, 8, 1, 8).toISOString(),
    ];
    expect(newMembersPerWeek(joined, NOW, 3)).toEqual([0, 1, 2]);
  });
});
