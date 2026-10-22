/**
 * Pure helpers behind the class dialog (issue #748): the weekly repeat,
 * the scope of an edit or a delete on a class of a series, the room
 * filter of the planning and the 409 `schedule_conflict` body.
 */
import { ScheduleConflictProblemSchema } from '@athlya/shared/schemas/api';

import type { ScheduleConflictItem } from '@athlya/shared/schemas/api';

/** Edit or delete one occurrence, or it and every later one of its series. */
export type SeriesScope = 'one' | 'following';

/** ISO weekdays, Monday first. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoDay = (typeof ISO_WEEKDAYS)[number];

export type RepeatEnd = 'count' | 'until';

export interface RepeatDraft {
  readonly enabled: boolean;
  readonly weekdays: ReadonlyArray<IsoDay>;
  readonly end: RepeatEnd;
  readonly count: string;
  readonly until: string;
}

/** ISO weekday of a local `YYYY-MM-DDTHH:MM` input value, or null. */
export function isoWeekdayOfLocal(local: string): IsoDay | null {
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return null;
  return (((date.getDay() + 6) % 7) + 1) as IsoDay;
}

/** The repeat section as first shown: off, on the weekday of the start, eight classes. */
export function defaultRepeat(startsAtLocal: string): RepeatDraft {
  const day = isoWeekdayOfLocal(startsAtLocal);
  return {
    enabled: false,
    weekdays: day === null ? [] : [day],
    end: 'count',
    count: '8',
    until: '',
  };
}

export function toggleWeekday(days: ReadonlyArray<IsoDay>, day: IsoDay): IsoDay[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}

/** The `recurrence` of `POST /v1/classes/series`, unvalidated (the schema checks it). */
export function recurrenceOf(repeat: RepeatDraft): {
  weekdays: number[];
  count?: number;
  until?: string;
} {
  return repeat.end === 'count'
    ? { weekdays: [...repeat.weekdays], count: Number(repeat.count) }
    : { weekdays: [...repeat.weekdays], until: repeat.until };
}

/** The browser's IANA time zone, which every occurrence keeps its wall-clock time in. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `HH:MM` of a local `YYYY-MM-DDTHH:MM` input value. */
export function localTimeOf(local: string): string {
  return local.slice(11, 16);
}

/**
 * The clashes of a 409 `schedule_conflict`, or null for any other
 * error. Reads the Problem Details the API client attached.
 */
export function scheduleConflictsOf(err: unknown): ReadonlyArray<ScheduleConflictItem> | null {
  const problem = (err as { problem?: unknown } | null)?.problem;
  const parsed = ScheduleConflictProblemSchema.safeParse(problem);
  return parsed.success ? parsed.data.conflicts : null;
}

/** The `code` of a Problem Details error, if any. */
export function problemCodeOf(err: unknown): string | undefined {
  const code = (err as { problem?: { code?: unknown } } | null)?.problem?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Classes in `roomId`, or every class when no room is picked. */
export function inRoom<T extends { readonly roomId?: string | null | undefined }>(
  items: ReadonlyArray<T>,
  roomId: string | null,
): ReadonlyArray<T> {
  return roomId === null ? items : items.filter((item) => item.roomId === roomId);
}
