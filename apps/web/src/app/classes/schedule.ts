/**
 * Pure helpers behind the `/classes` booking calendar: the week strip
 * (seven local days from today), the day each class falls on, and what a
 * card's capacity line says.
 *
 * Days are the member's local days, so a class at 23:30 sits under the
 * evening it is held, whatever the UTC date.
 */

/** Days in the week strip. */
export const WEEK_LENGTH = 7;

/** Weeks the strip can page through; the fetch window covers them. */
export const WEEKS_SHOWN = 2;

/** `YYYY-MM-DD` of the local day `date` falls on. */
export function localDayKey(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local midnight of the seven days of week `weekOffset`, the first week starting today. */
export function weekDays(now: Date, weekOffset: number): readonly Date[] {
  return Array.from(
    { length: WEEK_LENGTH },
    (_, i) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + weekOffset * WEEK_LENGTH + i),
  );
}

/** Items grouped by the local day they start on, each group sorted by start time. */
export function groupByDay<T extends { readonly startsAt: string }>(
  items: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const item of sorted) {
    const key = localDayKey(new Date(item.startsAt));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

/**
 * The week and day the strip opens on: the first day from today that has
 * a class, or today when none of the shown weeks has one.
 */
export function initialSelection(
  now: Date,
  groups: ReadonlyMap<string, readonly unknown[]>,
): { readonly weekOffset: number; readonly dayKey: string } {
  for (let weekOffset = 0; weekOffset < WEEKS_SHOWN; weekOffset += 1) {
    for (const day of weekDays(now, weekOffset)) {
      const key = localDayKey(day);
      if ((groups.get(key)?.length ?? 0) > 0) return { weekOffset, dayKey: key };
    }
  }
  return { weekOffset: 0, dayKey: localDayKey(now) };
}

/** The first day after `dayKey`, within the shown weeks, that has a class. */
export function nextDayWithClasses(
  now: Date,
  dayKey: string,
  groups: ReadonlyMap<string, readonly unknown[]>,
): { readonly weekOffset: number; readonly dayKey: string } | null {
  for (let weekOffset = 0; weekOffset < WEEKS_SHOWN; weekOffset += 1) {
    for (const day of weekDays(now, weekOffset)) {
      const key = localDayKey(day);
      if (key > dayKey && (groups.get(key)?.length ?? 0) > 0) return { weekOffset, dayKey: key };
    }
  }
  return null;
}

/**
 * What a card's capacity line shows. The bar fills with the seats already
 * taken, the same quantity as the `taken / capacity` text next to it, so
 * an empty class reads as an empty bar and a full one as a full bar.
 */
export interface CapacityView {
  readonly taken: number;
  readonly capacity: number;
  readonly remaining: number;
  /** Share of seats taken, between 0 and 1. */
  readonly ratio: number;
  readonly full: boolean;
}

export function capacityView(capacity: number, remaining: number): CapacityView {
  const left = Math.min(Math.max(remaining, 0), capacity);
  const taken = capacity - left;
  return {
    taken,
    capacity,
    remaining: left,
    ratio: capacity > 0 ? taken / capacity : 1,
    full: left === 0,
  };
}
