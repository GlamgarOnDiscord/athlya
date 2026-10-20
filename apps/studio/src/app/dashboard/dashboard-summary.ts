/**
 * Pure reducers behind the `/dashboard` overview, computed from the
 * classes `GET /v1/classes` already returns (`ClassWithRemainingSchema`:
 * `capacity` and the seats still `remaining`). Days and weeks are local:
 * the week runs Monday to Sunday, like the planning.
 */
import { addDays, isSameDay, startOfDay, startOfWeek } from 'date-fns';

/** The fields of a `GET /v1/classes` item the overview reads. */
export interface OverviewClass {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly durationMin: number;
  readonly capacity: number;
  readonly remaining: number;
}

/** Days loaded by the overview: this week and the next one. */
const OVERVIEW_DAYS = 14;
const UPCOMING_LIMIT = 5;

type ClassTiming = 'done' | 'live' | 'later';

interface WeekFill {
  readonly classes: number;
  readonly booked: number;
  readonly capacity: number;
  /** Whole percent of booked seats, `null` when the week offers no seat. */
  readonly percent: number | null;
}

interface DashboardSummary<T extends OverviewClass> {
  readonly today: ReadonlyArray<T>;
  readonly upcoming: ReadonlyArray<T>;
  readonly week: WeekFill;
}

export function overviewRange(now: Date): { from: Date; to: Date } {
  const from = startOfWeek(now, { weekStartsOn: 1 });
  return { from, to: addDays(from, OVERVIEW_DAYS) };
}

export function bookedSeats(cls: OverviewClass): number {
  return Math.max(0, cls.capacity - cls.remaining);
}

export function classTiming(cls: OverviewClass, now: Date): ClassTiming {
  const start = new Date(cls.startsAt).getTime();
  const end = start + cls.durationMin * 60_000;
  if (now.getTime() >= end) return 'done';
  return now.getTime() >= start ? 'live' : 'later';
}

export function summarize<T extends OverviewClass>(
  items: ReadonlyArray<T>,
  now: Date,
): DashboardSummary<T> {
  const sorted = [...items].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 7);
  const tomorrow = addDays(startOfDay(now), 1);

  const inWeek = sorted.filter((c) => {
    const start = new Date(c.startsAt);
    return start >= weekStart && start < weekEnd;
  });
  const booked = inWeek.reduce((sum, c) => sum + bookedSeats(c), 0);
  const capacity = inWeek.reduce((sum, c) => sum + c.capacity, 0);

  return {
    today: sorted.filter((c) => isSameDay(new Date(c.startsAt), now)),
    upcoming: sorted.filter((c) => new Date(c.startsAt) >= tomorrow).slice(0, UPCOMING_LIMIT),
    week: {
      classes: inWeek.length,
      booked,
      capacity,
      percent: capacity === 0 ? null : Math.round((booked / capacity) * 100),
    },
  };
}
