/**
 * Drizzle-backed `listMyReservations` query for
 * `GET /v1/reservations/me`.
 *
 * `@athlya/reservations` does NOT ship a dedicated service function
 * for this read — the use case is a straightforward join that
 * projects the member's reservations enriched with the owning class
 * metadata. We therefore implement it directly at the adapter layer
 * rather than introducing a new domain module for a single query.
 *
 * Query shape:
 *
 *   SELECT r.*, c.title AS class_title, c.starts_at AS class_starts_at,
 *          c.duration_min AS class_duration_min
 *   FROM reservations r
 *   JOIN classes c ON c.id = r.class_id
 *   WHERE r.user_id = $userId
 *     AND ($from IS NULL OR c.starts_at >= $from)
 *     AND ($to   IS NULL OR c.starts_at <= $to)
 *   ORDER BY c.starts_at ASC
 *   LIMIT $limit;
 *
 * The default window (90 days ending now + 90 days from now) is the
 * same as the one `@athlya/reservations/list` applies to class
 * listings — keeping the two client-facing endpoints symmetric.
 *
 * Returned items match the shape the `/v1/reservations/me` handler
 * emits: a reservation record flattened with selected class fields
 * so the mobile / web UI does not need a second round-trip.
 *
 * @see Requirements 7.4, 10.1.
 */

import { classes, reservations } from '@athlya/db/schema';
import { and, asc, eq, gte, lte } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';

/** Default lookback window, aligned with `ListClassesQuerySchema`. */
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_LOOKAHEAD_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Query params mirrored from `ListMyReservationsQuerySchema`. */
export interface ListMyReservationsQuery {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly limit?: number | undefined;
}

/** Row shape returned to the route handler — flattened for the client. */
export interface ReservationListItem {
    readonly id: string;
    readonly classId: string;
    readonly userId: string;
    readonly status: 'confirmed' | 'waitlist' | 'cancelled' | 'no_show';
    readonly createdAt: string;
    readonly cancelledAt: string | null;
    readonly checkedInAt: string | null;
    readonly class: {
        readonly id: string;
        readonly title: string;
        readonly startsAt: string;
        readonly durationMin: number;
    };
}

export interface ListMyReservationsDeps {
    readonly db: AthlyaDbAny;
}

/**
 * Fetch one page of the authenticated member's reservations,
 * flattened with the owning class metadata.
 *
 * Clamps `limit` to `[1, 100]` — the route layer's Zod validator
 * already enforces this, but defensive bounds keep the query safe
 * even if a caller bypasses validation (e.g. an internal script).
 */
export async function listMyReservations(
    userId: string,
    query: ListMyReservationsQuery,
    deps: ListMyReservationsDeps,
): Promise<{ items: ReservationListItem[] }> {
    const nowMs = Date.now();
    const from =
        query.from !== undefined
            ? new Date(query.from)
            : new Date(nowMs - DEFAULT_LOOKBACK_DAYS * MS_PER_DAY);
    const to =
        query.to !== undefined
            ? new Date(query.to)
            : new Date(nowMs + DEFAULT_LOOKAHEAD_DAYS * MS_PER_DAY);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    const rows = await withConnectionRetry(() =>
        deps.db
            .select({
                id: reservations.id,
                classId: reservations.classId,
                userId: reservations.userId,
                status: reservations.status,
                createdAt: reservations.createdAt,
                cancelledAt: reservations.cancelledAt,
                checkedInAt: reservations.checkedInAt,
                classTitle: classes.title,
                classStartsAt: classes.startsAt,
                classDurationMin: classes.durationMin,
            })
            .from(reservations)
            .innerJoin(classes, eq(classes.id, reservations.classId))
            .where(
                and(
                    eq(reservations.userId, userId),
                    gte(classes.startsAt, from),
                    lte(classes.startsAt, to),
                ),
            )
            .orderBy(asc(classes.startsAt))
            .limit(limit),
    );

    const items: ReservationListItem[] = rows.map((row) => ({
        id: row.id,
        classId: row.classId,
        userId: row.userId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        checkedInAt: row.checkedInAt?.toISOString() ?? null,
        class: {
            id: row.classId,
            title: row.classTitle,
            startsAt: row.classStartsAt.toISOString(),
            durationMin: row.classDurationMin,
        },
    }));

    return { items };
}
