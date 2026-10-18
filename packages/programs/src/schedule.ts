/**
 * Pure calendar logic of a program subscription.
 *
 * Dates are calendar dates (`YYYY-MM-DD`) in the member's own time
 * zone: the client sends its local date, so no time zone conversion
 * happens here. Day 1 of week 1 is the subscription's `startsOn`;
 * `dayNumber` counts from it (1..7), independently of the weekday.
 */

import type { ActiveSchedule } from './ports.js';
import type { TodayWorkoutItem } from '@athlya/shared/schemas/api';

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** UTC midnight of a valid `YYYY-MM-DD`, or `null`. */
function parseLocalDate(value: string): number | null {
  const match = LOCAL_DATE.exec(value);
  if (match === null) return null;
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  // Rejects overflow such as 2026-02-30, which Date.UTC rolls over.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

export function isLocalDate(value: string): boolean {
  return parseLocalDate(value) !== null;
}

function requireLocalDate(value: string): number {
  const ms = parseLocalDate(value);
  if (ms === null) throw new RangeError(`invalid calendar date: ${value}`);
  return ms;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((requireLocalDate(to) - requireLocalDate(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(requireLocalDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC calendar date of `now`. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type ScheduleDay =
  | { readonly status: 'not_started' }
  | { readonly status: 'completed' }
  | { readonly status: 'active'; readonly weekNumber: number; readonly dayNumber: number };

/** Locate `date` in a program of `totalWeeks` weeks started on `startsOn`. */
export function resolveScheduleDay(
  startsOn: string,
  date: string,
  totalWeeks: number,
): ScheduleDay {
  const offset = daysBetween(startsOn, date);
  if (offset < 0) return { status: 'not_started' };
  if (offset >= totalWeeks * 7) return { status: 'completed' };
  return {
    status: 'active',
    weekNumber: Math.floor(offset / 7) + 1,
    dayNumber: (offset % 7) + 1,
  };
}

/** The mobile home entry for one active subscription on `date`. */
export function resolveTodayItem(schedule: ActiveSchedule, date: string): TodayWorkoutItem {
  const { subscription, program } = schedule;
  const totalWeeks = program.weeks.length;
  const base = {
    subscriptionId: subscription.id,
    program: { id: program.id, title: program.title },
    startsOn: subscription.startsOn,
    totalWeeks,
  };
  const day = resolveScheduleDay(subscription.startsOn, date, totalWeeks);
  if (day.status !== 'active') {
    return { ...base, status: day.status, weekNumber: null, dayNumber: null, workout: null };
  }
  const week = program.weeks.find((w) => w.weekNumber === day.weekNumber);
  const workout = week?.workouts.find((w) => w.dayNumber === day.dayNumber) ?? null;
  return {
    ...base,
    status: workout === null ? 'rest' : 'scheduled',
    weekNumber: day.weekNumber,
    dayNumber: day.dayNumber,
    workout,
  };
}
