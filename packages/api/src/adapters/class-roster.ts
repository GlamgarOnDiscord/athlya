/**
 * Class roster for the studio team (issue #746): who is booked on a
 * class, who waits for a seat, who has been checked in, and the manual
 * check-in staff do from that list.
 *
 * Access: the studio admin, or the coach the class is assigned to
 * (`classes.coach_id`). RLS already lets every admin and coach of the
 * studio read its classes, reservations and members
 * (`classes_read_same_studio`, `reservations_read_admin_same_studio`,
 * `users_read_same_studio`), so the narrower "coach of this class" rule
 * is enforced here, before any roster row is read.
 *
 * Every statement runs in `withTenant` with the caller's claims on the
 * postgres-js handle, and the stamp goes through the SECURITY DEFINER
 * `checkin_mark_reservation` (migration 0045) like a kiosk scan: same
 * column, same 5-per-hour bound per member, no new database grant.
 */

import { withTenant } from '@athlya/db/client';
import { classes, reservations, users } from '@athlya/db/schema';
import { CHECKIN_WINDOW_HALF_MS } from '@athlya/reservations/checkin';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { CheckinStampRejectedError, createDrizzleCheckinRepo } from './checkins-deps.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { RosterCheckInOutcome, RosterOutcome } from '../routes/classes.js';
import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { ReservationRow } from '@athlya/db/schema';
import type { ClassRosterEntry, RosterPerson } from '@athlya/shared/schemas/api';

/** How long after a class ends staff may still mark a member present. */
export const ATTENDANCE_LATE_MS = 24 * 60 * 60 * 1000;

export interface RosterClass {
  readonly id: string;
  readonly coachId: string | null;
  readonly title: string;
  readonly startsAt: Date;
  readonly durationMin: number;
  readonly capacity: number;
  readonly coach: RosterPerson | null;
}

export interface RosterRow {
  readonly reservationId: string;
  readonly status: ReservationRow['status'];
  readonly bookedAt: Date;
  readonly checkedInAt: Date | null;
  readonly member: RosterPerson;
}

export interface RosterRepo {
  /** A live class of the caller's studio, with its coach. */
  findClass(classId: string): Promise<RosterClass | null>;
  /** Confirmed and waitlisted reservations of the class, oldest booking first. */
  listRoster(classId: string): Promise<RosterRow[]>;
  /** One reservation of the class, whatever its status. */
  findEntry(classId: string, reservationId: string): Promise<RosterRow | null>;
  /** Stamp `checked_in_at`; throws {@link CheckinStampRejectedError} when nothing was stamped. */
  markCheckedIn(reservationId: string, at: Date): Promise<void>;
}

/** The window in which a confirmed member of the class may be marked present. */
export function attendanceWindow(
  startsAt: Date,
  durationMin: number,
): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(startsAt.getTime() - CHECKIN_WINDOW_HALF_MS),
    closesAt: new Date(startsAt.getTime() + durationMin * 60_000 + ATTENDANCE_LATE_MS),
  };
}

/** The studio admin, or the coach the class is assigned to. */
export function canManageRoster(claims: AuthClaims, cls: Pick<RosterClass, 'coachId'>): boolean {
  if (claims.role === 'admin') return true;
  return claims.role === 'coach' && cls.coachId !== null && cls.coachId === claims.userId;
}

function toEntry(row: RosterRow): ClassRosterEntry | null {
  if (row.status !== 'confirmed' && row.status !== 'waitlist') return null;
  return {
    reservationId: row.reservationId,
    status: row.status,
    bookedAt: row.bookedAt.toISOString(),
    checkedInAt: row.checkedInAt === null ? null : row.checkedInAt.toISOString(),
    member: row.member,
  };
}

export async function getRosterWith(
  claims: AuthClaims,
  classId: string,
  repo: RosterRepo,
): Promise<RosterOutcome> {
  const cls = await repo.findClass(classId);
  if (cls === null) return { kind: 'not_found' };
  if (!canManageRoster(claims, cls)) return { kind: 'forbidden' };

  const entries = (await repo.listRoster(classId)).flatMap((row) => {
    const entry = toEntry(row);
    return entry === null ? [] : [entry];
  });
  const window = attendanceWindow(cls.startsAt, cls.durationMin);
  return {
    kind: 'ok',
    roster: {
      class: {
        id: cls.id,
        title: cls.title,
        startsAt: cls.startsAt.toISOString(),
        durationMin: cls.durationMin,
        capacity: cls.capacity,
        coach: cls.coach,
      },
      confirmed: entries.filter((e) => e.status === 'confirmed'),
      waitlist: entries.filter((e) => e.status === 'waitlist'),
      attendance: {
        opensAt: window.opensAt.toISOString(),
        closesAt: window.closesAt.toISOString(),
      },
    },
  };
}

export async function markAttendanceWith(
  claims: AuthClaims,
  classId: string,
  reservationId: string,
  ports: { readonly repo: RosterRepo; readonly now: () => number },
): Promise<RosterCheckInOutcome> {
  const { repo } = ports;
  const cls = await repo.findClass(classId);
  if (cls === null) return { kind: 'not_found' };
  if (!canManageRoster(claims, cls)) return { kind: 'forbidden' };

  const row = await repo.findEntry(classId, reservationId);
  if (row === null) return { kind: 'not_found' };
  if (row.status !== 'confirmed') return { kind: 'fail', reason: 'not_confirmed' };
  if (row.checkedInAt !== null) return { kind: 'fail', reason: 'already_checked_in' };

  const at = new Date(ports.now());
  const window = attendanceWindow(cls.startsAt, cls.durationMin);
  if (at < window.opensAt || at > window.closesAt) {
    return { kind: 'fail', reason: 'outside_window' };
  }

  try {
    await repo.markCheckedIn(reservationId, at);
  } catch (err) {
    if (!(err instanceof CheckinStampRejectedError)) throw err;
    // `no_reservation`: cancelled or its class deleted since the read above.
    return {
      kind: 'fail',
      reason: err.reason === 'no_reservation' ? 'not_confirmed' : err.reason,
    };
  }

  const stamped = await repo.findEntry(classId, reservationId);
  const entry = stamped === null ? null : toEntry(stamped);
  return entry === null ? { kind: 'not_found' } : { kind: 'checked_in', entry };
}

/* ------------------------------------------------------------------ */
/*  Drizzle repository                                                 */
/* ------------------------------------------------------------------ */

/** The class's coach, joined next to the members of the roster. */
const coach = alias(users, 'coach');

const rosterColumns = {
  reservationId: reservations.id,
  status: reservations.status,
  bookedAt: reservations.createdAt,
  checkedInAt: reservations.checkedInAt,
  memberId: users.id,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
};

interface RosterSelect {
  reservationId: string;
  status: RosterRow['status'];
  bookedAt: Date;
  checkedInAt: Date | null;
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
}

function toRosterRow(row: RosterSelect): RosterRow {
  return {
    reservationId: row.reservationId,
    status: row.status,
    bookedAt: row.bookedAt,
    checkedInAt: row.checkedInAt,
    member: { id: row.memberId, displayName: row.displayName, avatarUrl: row.avatarUrl },
  };
}

export function createDrizzleRosterRepo(db: AthlyaDb, claims: TenantClaims): RosterRepo {
  const stamp = createDrizzleCheckinRepo(db, claims);
  return {
    async findClass(classId) {
      const [row] = await withTenant(db, claims, (tx) =>
        tx
          .select({
            id: classes.id,
            coachId: classes.coachId,
            title: classes.title,
            startsAt: classes.startsAt,
            durationMin: classes.durationMin,
            capacity: classes.capacity,
            coachName: coach.displayName,
            coachAvatarUrl: coach.avatarUrl,
          })
          .from(classes)
          .leftJoin(coach, and(eq(coach.id, classes.coachId), isNull(coach.deletedAt)))
          .where(
            and(
              eq(classes.id, classId),
              eq(classes.studioId, claims.studioId),
              isNull(classes.deletedAt),
            ),
          )
          .limit(1),
      );
      if (row === undefined) return null;
      const { coachName, coachAvatarUrl, ...cls } = row;
      return {
        ...cls,
        coach:
          cls.coachId === null || coachName === null
            ? null
            : { id: cls.coachId, displayName: coachName, avatarUrl: coachAvatarUrl },
      };
    },

    async listRoster(classId) {
      const rows = await withTenant(db, claims, (tx) =>
        tx
          .select(rosterColumns)
          .from(reservations)
          .innerJoin(users, eq(users.id, reservations.userId))
          .where(
            and(
              eq(reservations.classId, classId),
              inArray(reservations.status, ['confirmed', 'waitlist']),
              isNull(users.deletedAt),
            ),
          )
          .orderBy(asc(reservations.createdAt), asc(reservations.id)),
      );
      return rows.map(toRosterRow);
    },

    async findEntry(classId, reservationId) {
      const [row] = await withTenant(db, claims, (tx) =>
        tx
          .select(rosterColumns)
          .from(reservations)
          .innerJoin(users, eq(users.id, reservations.userId))
          .where(and(eq(reservations.id, reservationId), eq(reservations.classId, classId)))
          .limit(1),
      );
      return row === undefined ? null : toRosterRow(row);
    },

    async markCheckedIn(reservationId, at) {
      await stamp.markCheckedIn(reservationId, at);
    },
  };
}
