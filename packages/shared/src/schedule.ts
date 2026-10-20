/**
 * Pure scheduling helpers for the studio planning (issue #748):
 *
 *   - wall-clock time in an IANA time zone, both ways, so a weekly series
 *     keeps its local start time across a DST change;
 *   - {@link expandWeeklySeries}: the start instants of a weekly
 *     repetition on chosen ISO weekdays, until a local date or for a
 *     number of occurrences;
 *   - {@link findScheduleConflicts}: which existing classes share a room
 *     or a coach with a candidate over an overlapping interval.
 *
 * Intervals are half-open, `[start, start + duration)`: a class ending at
 * 10:00 and one starting at 10:00 do not clash. No I/O and no clock: the
 * API runs these over rows it read, the studio app over rows it shows.
 */

/** Hard cap on the occurrences one series may create. */
export const MAX_SERIES_OCCURRENCES = 60;

/**
 * Days scanned from the first one: enough for {@link MAX_SERIES_OCCURRENCES}
 * weekly occurrences on a single weekday that is not the first day's.
 */
const SCAN_DAYS = MAX_SERIES_OCCURRENCES * 7 + 6;

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is an IANA zone the runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function partsOf(date: Date, timeZone: string): ZonedParts & { readonly second: number } {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year'] ?? 0,
    month: values['month'] ?? 1,
    day: values['day'] ?? 1,
    hour: values['hour'] ?? 0,
    minute: values['minute'] ?? 0,
    second: values['second'] ?? 0,
  };
}

/** Local calendar date and time of `date` in `timeZone`. */
export function toZonedParts(date: Date, timeZone: string): ZonedParts {
  const { year, month, day, hour, minute } = partsOf(date, timeZone);
  return { year, month, day, hour, minute };
}

/** Offset of `timeZone` from UTC at `instantMs`, in milliseconds. */
function offsetAt(instantMs: number, timeZone: string): number {
  const p = partsOf(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `timeZone` reads `parts`. A
 * time skipped by a DST jump lands one hour later; a repeated one takes
 * its first reading.
 */
export function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // The offsets in force a day before and a day after: they differ only
  // around a transition, and every instant of that day uses one of them.
  const before = offsetAt(guess - 86_400_000, timeZone);
  const after = offsetAt(guess + 86_400_000, timeZone);
  const readings = [guess - before, guess - after].filter(
    (instant, i) => offsetAt(instant, timeZone) === (i === 0 ? before : after),
  );
  if (readings.length === 0) return new Date(guess - before);
  return new Date(Math.min(...readings));
}

/** `HH:MM` (24 h) to hour and minute, or null. */
export function parseLocalTime(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (match === null) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Same local day as `date` in `timeZone`, at the `HH:MM` wall-clock time. */
export function retimeInZone(date: Date, time: string, timeZone: string): Date {
  const parsed = parseLocalTime(time);
  if (parsed === null) throw new RangeError(`invalid local time: ${time}`);
  const { year, month, day } = toZonedParts(date, timeZone);
  return zonedTimeToUtc({ year, month, day, ...parsed }, timeZone);
}

export interface WeeklySeriesRule {
  /** Start of the first candidate day; its wall-clock time is kept for every occurrence. */
  readonly firstStart: Date;
  readonly weekdays: ReadonlyArray<IsoWeekday>;
  /** Last local date (inclusive), `YYYY-MM-DD`. Exactly one of `until` / `count`. */
  readonly until?: string;
  readonly count?: number;
  readonly timeZone: string;
}

export type WeeklySeriesExpansion =
  | { readonly ok: true; readonly occurrences: ReadonlyArray<Date> }
  | { readonly ok: false; readonly reason: 'no_occurrences' | 'too_many_occurrences' };

function parseLocalDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(ms);
  return check.getUTCDate() === Number(match[3]) ? ms : null;
}

/**
 * Start instants of a weekly series: every local day from the day of
 * `firstStart` whose ISO weekday is in `weekdays`, at the local time of
 * `firstStart`, until `until` (inclusive) or until `count` occurrences.
 * The first day only counts when its weekday is chosen. Refuses a rule
 * that yields nothing or more than {@link MAX_SERIES_OCCURRENCES}.
 */
export function expandWeeklySeries(rule: WeeklySeriesRule): WeeklySeriesExpansion {
  const days = new Set<number>(rule.weekdays);
  const start = toZonedParts(rule.firstStart, rule.timeZone);
  const firstDayMs = Date.UTC(start.year, start.month - 1, start.day);
  const untilMs = rule.until === undefined ? null : parseLocalDate(rule.until);
  const wanted = rule.count;
  if ((untilMs === null) === (wanted === undefined) || days.size === 0) {
    return { ok: false, reason: 'no_occurrences' };
  }
  if (wanted !== undefined && wanted > MAX_SERIES_OCCURRENCES) {
    return { ok: false, reason: 'too_many_occurrences' };
  }

  const occurrences: Date[] = [];
  for (let offset = 0; offset <= SCAN_DAYS; offset++) {
    const dayMs = firstDayMs + offset * 86_400_000;
    if (untilMs !== null && dayMs > untilMs) break;
    const day = new Date(dayMs);
    const isoWeekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (!days.has(isoWeekday)) continue;
    if (occurrences.length === MAX_SERIES_OCCURRENCES) {
      return { ok: false, reason: 'too_many_occurrences' };
    }
    occurrences.push(
      zonedTimeToUtc(
        {
          year: day.getUTCFullYear(),
          month: day.getUTCMonth() + 1,
          day: day.getUTCDate(),
          hour: start.hour,
          minute: start.minute,
        },
        rule.timeZone,
      ),
    );
    if (wanted !== undefined && occurrences.length === wanted) break;
  }
  if (occurrences.length === 0) return { ok: false, reason: 'no_occurrences' };
  return { ok: true, occurrences };
}

/* ------------------------------------------------------------------ */
/*  Conflicts                                                          */
/* ------------------------------------------------------------------ */

export interface ScheduleSlot {
  readonly startsAt: Date;
  readonly durationMin: number;
  readonly roomId: string | null;
  readonly coachId: string | null;
}

export interface ScheduledClass extends ScheduleSlot {
  readonly id: string;
  readonly title: string;
}

export type ConflictReason = 'room' | 'coach';

export interface ScheduleConflict {
  /** Index of the candidate in the list given to {@link findScheduleConflicts}. */
  readonly candidate: number;
  readonly existing: ScheduledClass;
  readonly reasons: ReadonlyArray<ConflictReason>;
}

/** Whether `[aStart, aEnd)` and `[bStart, bEnd)` share at least one instant. */
export function intervalsOverlap(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number,
): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

function endMs(slot: ScheduleSlot): number {
  return slot.startsAt.getTime() + slot.durationMin * 60_000;
}

/** Why `a` and `b` clash: the shared room, the shared coach, both or neither. */
export function conflictReasons(a: ScheduleSlot, b: ScheduleSlot): ConflictReason[] {
  if (!intervalsOverlap(a.startsAt.getTime(), endMs(a), b.startsAt.getTime(), endMs(b))) {
    return [];
  }
  const reasons: ConflictReason[] = [];
  if (a.roomId !== null && a.roomId === b.roomId) reasons.push('room');
  if (a.coachId !== null && a.coachId === b.coachId) reasons.push('coach');
  return reasons;
}

/**
 * Every (candidate, existing class) pair sharing a room or a coach over
 * an overlapping interval, in candidate order then existing order.
 * Classes whose id is in `ignore` (the ones being moved) never count.
 */
export function findScheduleConflicts(
  candidates: ReadonlyArray<ScheduleSlot>,
  existing: ReadonlyArray<ScheduledClass>,
  ignore: ReadonlySet<string> = new Set(),
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  candidates.forEach((candidate, index) => {
    for (const other of existing) {
      if (ignore.has(other.id)) continue;
      const reasons = conflictReasons(candidate, other);
      if (reasons.length > 0) conflicts.push({ candidate: index, existing: other, reasons });
    }
  });
  return conflicts;
}

/** Earliest start and latest end over `slots`, for a range query. */
export function scheduleWindow(
  slots: ReadonlyArray<ScheduleSlot>,
): { readonly from: Date; readonly to: Date } | null {
  if (slots.length === 0) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const slot of slots) {
    from = Math.min(from, slot.startsAt.getTime());
    to = Math.max(to, endMs(slot));
  }
  return { from: new Date(from), to: new Date(to) };
}
