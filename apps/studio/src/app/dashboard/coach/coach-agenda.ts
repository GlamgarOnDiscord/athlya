/**
 * Pure helpers behind the coach home and schedule. A coach's classes are
 * the ones whose `coachId` is the signed-in user, read from the same
 * `GET /v1/classes` the planning uses (the API has no coach filter yet).
 */
import { addDays, isSameDay, startOfDay } from 'date-fns';

import { classTiming, minutesUntil, type OverviewClass } from '../dashboard-summary';

/** A `GET /v1/classes` item with the coach it is assigned to. */
export interface AssignedClass extends OverviewClass {
  readonly coachId: string | null;
}

/** Days ahead the coach home reads, today included. */
export const AGENDA_DAYS = 8;
const UPCOMING_LIMIT = 8;

/** Classes assigned to `coachId`; an unassigned class belongs to nobody. */
export function classesOf<T extends AssignedClass>(items: ReadonlyArray<T>, coachId: string): T[] {
  return items.filter((c) => c.coachId === coachId);
}

/** The schedule's switch: the coach's own classes, or the whole studio. */
export type ClassScope = 'mine' | 'all';

export function scopeClasses<T extends AssignedClass>(
  items: ReadonlyArray<T>,
  scope: ClassScope,
  coachId: string,
): ReadonlyArray<T> {
  return scope === 'all' ? items : classesOf(items, coachId);
}

/** The window the coach home reads: from the start of today, {@link AGENDA_DAYS} long. */
export function agendaRange(now: Date): { from: Date; to: Date } {
  const from = startOfDay(now);
  return { from, to: addDays(from, AGENDA_DAYS) };
}

export type CoachFocus<T> =
  | { readonly kind: 'live'; readonly cls: T; readonly minutesLeft: number }
  | { readonly kind: 'next'; readonly cls: T; readonly minutes: number }
  | { readonly kind: 'none' };

export interface CoachAgenda<T> {
  /** Today's classes of the coach, done ones included, earliest first. */
  readonly today: ReadonlyArray<T>;
  /** The class the home leads with: the one running now, else the next to start. */
  readonly focus: CoachFocus<T>;
  /** The first class still to start, for the today list highlight. */
  readonly next: T | null;
  /** Classes after today, within the window, earliest first and capped. */
  readonly upcoming: ReadonlyArray<T>;
}

function byStart<T extends OverviewClass>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/**
 * The day of `coachId`, or of the whole studio when `coachId` is `null`
 * (the front desk, who follows every class).
 */
export function coachAgenda<T extends AssignedClass>(
  items: ReadonlyArray<T>,
  coachId: string | null,
  now: Date,
): CoachAgenda<T> {
  const mine = byStart(coachId === null ? [...items] : classesOf(items, coachId));
  const tomorrow = addDays(startOfDay(now), 1);
  const horizon = addDays(startOfDay(now), AGENDA_DAYS);
  const live = mine.find((c) => classTiming(c, now) === 'live');
  const next = mine.find((c) => new Date(c.startsAt) > now) ?? null;

  let focus: CoachFocus<T> = { kind: 'none' };
  if (live !== undefined) {
    const end = new Date(new Date(live.startsAt).getTime() + live.durationMin * 60_000);
    focus = { kind: 'live', cls: live, minutesLeft: minutesUntil(end.toISOString(), now) };
  } else if (next !== null) {
    focus = { kind: 'next', cls: next, minutes: minutesUntil(next.startsAt, now) };
  }

  return {
    today: mine.filter((c) => isSameDay(new Date(c.startsAt), now)),
    focus,
    next,
    upcoming: mine
      .filter((c) => {
        const start = new Date(c.startsAt);
        return start >= tomorrow && start < horizon;
      })
      .slice(0, UPCOMING_LIMIT),
  };
}
