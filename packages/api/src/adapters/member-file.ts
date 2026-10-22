/**
 * Member file for the studio admin (issue #746): the member's profile and
 * consents, their reservations to come and the latest past ones, and the
 * attendance counts.
 *
 * The route needs `members.file` (admin, manager, front desk). Every statement runs in one `withTenant`
 * transaction with the admin's claims, so `users_read_same_studio` and
 * `reservations_read_admin_same_studio` are what let the rows through;
 * the explicit `studio_id` filters repeat that scope in the query.
 */

import { withTenant } from '@athlya/db/client';
import { classes, reservations, users } from '@athlya/db/schema';
import { MEMBER_FILE_LIST_LIMIT } from '@athlya/shared/schemas/api';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { ReservationRow } from '@athlya/db/schema';
import type { MemberFileReservation, MemberFileResponse } from '@athlya/shared/schemas/api';

export interface MemberFileReservationRow {
  readonly id: string;
  readonly status: ReservationRow['status'];
  readonly bookedAt: Date;
  readonly cancelledAt: Date | null;
  readonly checkedInAt: Date | null;
  readonly classId: string;
  readonly classTitle: string;
  readonly classStartsAt: Date;
  readonly classDurationMin: number;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * The wire shape of one reservation, `null` for a seat hold still pending
 * payment confirmation: it is not a booking yet.
 */
export function toMemberFileReservation(
  row: MemberFileReservationRow,
): MemberFileReservation | null {
  if (row.status === 'pending') return null;
  return {
    id: row.id,
    status: row.status,
    bookedAt: row.bookedAt.toISOString(),
    cancelledAt: iso(row.cancelledAt),
    checkedInAt: iso(row.checkedInAt),
    class: {
      id: row.classId,
      title: row.classTitle,
      startsAt: row.classStartsAt.toISOString(),
      durationMin: row.classDurationMin,
    },
  };
}

const asList = (row: MemberFileReservationRow): MemberFileReservation[] => {
  const reservation = toMemberFileReservation(row);
  return reservation === null ? [] : [reservation];
};

/** Statuses a member file lists: every booking, not a pending seat hold. */
const LISTED_STATUSES = ['confirmed', 'waitlist', 'cancelled', 'no_show'] as const;

const reservationColumns = {
  id: reservations.id,
  status: reservations.status,
  bookedAt: reservations.createdAt,
  cancelledAt: reservations.cancelledAt,
  checkedInAt: reservations.checkedInAt,
  classId: classes.id,
  classTitle: classes.title,
  classStartsAt: classes.startsAt,
  classDurationMin: classes.durationMin,
};

/**
 * Load the member file of `memberId` as seen by `claims`, or `null` when
 * the id is not a live member of the caller's studio. `now` splits the
 * reservations into upcoming (class not started, still booked or
 * waitlisted) and past (class started, any status).
 */
export async function loadMemberFile(
  db: AthlyaDb,
  claims: TenantClaims,
  memberId: string,
  now: Date,
): Promise<MemberFileResponse | null> {
  return withTenant(db, claims, async (tx) => {
    const [member] = await tx
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        consents: users.consents,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          eq(users.id, memberId),
          eq(users.studioId, claims.studioId),
          isNull(users.deletedAt),
          isNotNull(users.email),
        ),
      )
      .limit(1);
    if (member === undefined || member.email === null) return null;

    const ofMember = and(
      eq(reservations.userId, memberId),
      eq(classes.studioId, claims.studioId),
      isNull(classes.deletedAt),
    );

    const upcoming = await tx
      .select(reservationColumns)
      .from(reservations)
      .innerJoin(classes, eq(classes.id, reservations.classId))
      .where(
        and(
          ofMember,
          gte(classes.startsAt, now),
          inArray(reservations.status, ['confirmed', 'waitlist']),
        ),
      )
      .orderBy(asc(classes.startsAt), asc(reservations.id))
      .limit(MEMBER_FILE_LIST_LIMIT);

    const past = await tx
      .select(reservationColumns)
      .from(reservations)
      .innerJoin(classes, eq(classes.id, reservations.classId))
      .where(
        and(ofMember, lt(classes.startsAt, now), inArray(reservations.status, LISTED_STATUSES)),
      )
      .orderBy(desc(classes.startsAt), desc(reservations.id))
      .limit(MEMBER_FILE_LIST_LIMIT);

    const [stats] = await tx
      .select({
        checkIns: sql<number>`count(*) filter (where ${reservations.checkedInAt} is not null)::int`,
        lastCheckInAt: sql<Date | null>`max(${reservations.checkedInAt})`,
        noShows: sql<number>`count(*) filter (where ${reservations.status} = 'no_show')::int`,
        cancellations: sql<number>`count(*) filter (where ${reservations.status} = 'cancelled')::int`,
      })
      .from(reservations)
      .innerJoin(classes, eq(classes.id, reservations.classId))
      .where(ofMember);

    const lastCheckInAt = stats?.lastCheckInAt ?? null;
    return {
      member: {
        id: member.id,
        email: member.email,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        role: member.role,
        consents: member.consents,
        createdAt: member.createdAt.toISOString(),
      },
      upcoming: upcoming.flatMap(asList),
      past: past.flatMap(asList),
      stats: {
        checkIns: Number(stats?.checkIns ?? 0),
        lastCheckInAt: lastCheckInAt === null ? null : new Date(lastCheckInAt).toISOString(),
        noShows: Number(stats?.noShows ?? 0),
        cancellations: Number(stats?.cancellations ?? 0),
      },
    };
  });
}
