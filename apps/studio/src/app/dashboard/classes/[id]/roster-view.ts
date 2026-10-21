/**
 * Pure helpers behind the class roster page: when staff may mark members
 * present, the head counts, and folding a fresh check-in into the list.
 */
import type { ClassRosterEntry, ClassRosterResponse } from '@athlya/shared/schemas/api';

export type AttendanceState = 'before' | 'open' | 'closed';

/** Where `now` sits against the roster's check-in window. */
export function attendanceState(
  window: ClassRosterResponse['attendance'],
  now: Date,
): AttendanceState {
  if (now < new Date(window.opensAt)) return 'before';
  if (now > new Date(window.closesAt)) return 'closed';
  return 'open';
}

export interface RosterStats {
  readonly booked: number;
  readonly checkedIn: number;
  readonly waitlist: number;
}

export function rosterStats(roster: ClassRosterResponse): RosterStats {
  return {
    booked: roster.confirmed.length,
    checkedIn: roster.confirmed.filter((e) => e.checkedInAt !== null).length,
    waitlist: roster.waitlist.length,
  };
}

/** The roster with `entry` in place of the row it updates. */
export function withEntry(
  roster: ClassRosterResponse,
  entry: ClassRosterEntry,
): ClassRosterResponse {
  const swap = (rows: ReadonlyArray<ClassRosterEntry>): ClassRosterEntry[] =>
    rows.map((row) => (row.reservationId === entry.reservationId ? entry : row));
  return { ...roster, confirmed: swap(roster.confirmed), waitlist: swap(roster.waitlist) };
}
