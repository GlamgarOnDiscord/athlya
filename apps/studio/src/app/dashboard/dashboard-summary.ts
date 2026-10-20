/**
 * Pure reducers behind the `/dashboard` overview, computed from the
 * classes `GET /v1/classes` already returns (`ClassWithRemainingSchema`:
 * `capacity` and the seats still `remaining`). Days and weeks are local:
 * the week runs Monday to Sunday, like the planning.
 */
import { addDays, addWeeks, isSameDay, startOfDay, startOfWeek } from 'date-fns';

/** The fields of a `GET /v1/classes` item the overview reads. */
export interface OverviewClass {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly durationMin: number;
  readonly capacity: number;
  readonly remaining: number;
}

const WEEK = { weekStartsOn: 1 } as const;
/** Weeks of history the overview loads: deltas, sparklines and the occupancy heatmap. */
export const HISTORY_WEEKS = 12;
const UPCOMING_DAYS = 7;
const UPCOMING_LIMIT = 8;
const TREND_WEEKS = 8;

export interface Range {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The two windows the overview reads. `GET /v1/classes` refuses a range
 * over 90 days, so the twelve past weeks and the current two are two calls.
 */
export function overviewRanges(now: Date): { history: Range; current: Range } {
  const weekStart = startOfWeek(now, WEEK);
  return {
    history: { from: addWeeks(weekStart, -HISTORY_WEEKS), to: weekStart },
    current: { from: weekStart, to: addDays(weekStart, 14) },
  };
}

export function bookedSeats(cls: OverviewClass): number {
  return Math.max(0, cls.capacity - cls.remaining);
}

export type ClassTiming = 'done' | 'live' | 'later';

export function classTiming(cls: OverviewClass, now: Date): ClassTiming {
  const start = new Date(cls.startsAt).getTime();
  const end = start + cls.durationMin * 60_000;
  if (now.getTime() >= end) return 'done';
  return now.getTime() >= start ? 'live' : 'later';
}

export interface PeriodStats {
  readonly classes: number;
  readonly booked: number;
  readonly capacity: number;
  /** Whole percent of booked seats, `null` when the period offers no seat. */
  readonly percent: number | null;
}

function inRange(cls: OverviewClass, from: Date, to: Date): boolean {
  const start = new Date(cls.startsAt);
  return start >= from && start < to;
}

export function periodStats(
  items: ReadonlyArray<OverviewClass>,
  from: Date,
  to: Date,
): PeriodStats {
  const inPeriod = items.filter((c) => inRange(c, from, to));
  const booked = inPeriod.reduce((sum, c) => sum + bookedSeats(c), 0);
  const capacity = inPeriod.reduce((sum, c) => sum + c.capacity, 0);
  return {
    classes: inPeriod.length,
    booked,
    capacity,
    percent: capacity === 0 ? null : Math.round((booked / capacity) * 100),
  };
}

/** One value per day from `from`, `days` long. */
function perDay(
  items: ReadonlyArray<OverviewClass>,
  from: Date,
  days: number,
  value: (c: OverviewClass) => number,
): number[] {
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i);
    return items
      .filter((c) => isSameDay(new Date(c.startsAt), day))
      .reduce((sum, c) => sum + value(c), 0);
  });
}

export interface DashboardSummary<T extends OverviewClass> {
  readonly today: ReadonlyArray<T>;
  /** First class still to start, today or later. */
  readonly next: T | null;
  /** Classes of the next seven days that have not started, capped. */
  readonly upcoming: ReadonlyArray<T>;
  readonly week: PeriodStats;
  readonly previousWeek: PeriodStats;
  /** Classes on the same weekday one week earlier, for the today delta. */
  readonly sameDayLastWeek: number;
  /** Classes per day over the last seven days, today last. */
  readonly classesTrend: ReadonlyArray<number>;
  /** Seats booked per day of the current week, Monday first. */
  readonly bookingsByDay: ReadonlyArray<number>;
  /** Seats booked per week over the last weeks, current week last. */
  readonly bookingsTrend: ReadonlyArray<number>;
  /** Fill percent of the last weeks, current week last; `null` for a week without seats. */
  readonly fillTrend: ReadonlyArray<number | null>;
  /** Whether any class exists before the current week: deltas need a previous period. */
  readonly hasHistory: boolean;
}

export function summarize<T extends OverviewClass>(
  items: ReadonlyArray<T>,
  now: Date,
): DashboardSummary<T> {
  const sorted = [...items].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const weekStart = startOfWeek(now, WEEK);
  const today = startOfDay(now);
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) => {
    const from = addWeeks(weekStart, i - TREND_WEEKS + 1);
    return periodStats(sorted, from, addDays(from, 7));
  });

  return {
    today: sorted.filter((c) => isSameDay(new Date(c.startsAt), now)),
    next: sorted.find((c) => new Date(c.startsAt) > now) ?? null,
    upcoming: sorted
      .filter((c) => new Date(c.startsAt) > now && inRange(c, today, addDays(today, UPCOMING_DAYS)))
      .slice(0, UPCOMING_LIMIT),
    week: periodStats(sorted, weekStart, addDays(weekStart, 7)),
    previousWeek: periodStats(sorted, addWeeks(weekStart, -1), weekStart),
    sameDayLastWeek: perDay(sorted, addDays(today, -7), 1, () => 1)[0] ?? 0,
    classesTrend: perDay(sorted, addDays(today, -6), 7, () => 1),
    bookingsByDay: perDay(sorted, weekStart, 7, bookedSeats),
    bookingsTrend: weeks.map((w) => w.booked),
    fillTrend: weeks.map((w) => w.percent),
    hasHistory: sorted.some((c) => new Date(c.startsAt) < weekStart),
  };
}

/** Minutes from `now` until `startsAt`, rounded down, never negative. */
export function minutesUntil(startsAt: string, now: Date): number {
  return Math.max(0, Math.floor((new Date(startsAt).getTime() - now.getTime()) / 60_000));
}

/** New members per week over the last `weeks` weeks, current week last. */
export function newMembersPerWeek(
  createdAt: ReadonlyArray<string>,
  now: Date,
  weeks: number,
): number[] {
  const weekStart = startOfWeek(now, WEEK);
  return Array.from({ length: weeks }, (_, i) => {
    const from = addWeeks(weekStart, i - weeks + 1);
    const to = addDays(from, 7);
    return createdAt.filter((iso) => {
      const at = new Date(iso);
      return at >= from && at < to;
    }).length;
  });
}
