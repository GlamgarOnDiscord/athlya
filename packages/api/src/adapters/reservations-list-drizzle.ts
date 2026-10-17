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
 *     AND ($cursor IS NULL OR (c.starts_at, r.id) > ($cursor.startsAt, $cursor.id))
 *   ORDER BY c.starts_at ASC, r.id ASC
 *   LIMIT $limit + 1;     -- +1 to detect hasMore
 *
 * Cursor encoding: opaque base64url of `{ startsAt: string; id: string }`.
 * Primary key is `starts_at` (timestamp); `id` is the tie-breaker within
 * the same class slot. This `(startsAt, id)` tuple is safe for mixed
 * UUID v4/v7 rows — see migration 0016 note (issue #334).
 *
 * The default window (90 days ending now + 90 days from now) is the
 * same as the one `@athlya/reservations/list` applies to class
 * listings — keeping the two client-facing endpoints symmetric.
 *
 * @see Requirements 7.4, 10.1.
 */

import { withTenantHttp } from '@athlya/db';
import { classes, reservations } from '@athlya/db/schema';
import { and, asc, eq, gt, gte, lte, or, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';

/** Default lookback window, aligned with `ListClassesQuerySchema`. */
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_LOOKAHEAD_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Query params mirrored from `ListMyReservationsQuerySchema`. */
export interface ListMyReservationsQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
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

/**
 * The read always runs under the caller's tenant claims so the
 * `reservations` / `classes` RLS policies apply (issue #117): there is
 * no claim-less path.
 */
export interface ListMyReservationsDeps {
  readonly db: AthlyaDbHttp;
  readonly claims: TenantClaims;
}

/** Cursor shape encoded into a base64url-safe string. */
interface ReservationCursor {
  readonly startsAt: string;
  readonly id: string;
}

// Web-standard base64url (UTF-8 safe) so the cursor codec does not depend
// on the `nodejs_compat` Buffer polyfill.
function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

function encodeCursor(c: ReservationCursor): string {
  return toBase64Url(JSON.stringify(c));
}

function decodeCursor(raw: string): ReservationCursor | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'startsAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).startsAt === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as ReservationCursor;
    }
    return null;
  } catch {
    return null;
  }
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
): Promise<{ items: ReservationListItem[]; nextCursor: string | null }> {
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
  const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

  const cursorCondition =
    cursor !== null
      ? or(
          gt(classes.startsAt, new Date(cursor.startsAt)),
          and(
            sql`${classes.startsAt} = ${new Date(cursor.startsAt)}`,
            gt(reservations.id, cursor.id),
          ),
        )
      : undefined;

  const { db, claims } = deps;
  const rows = await withConnectionRetry(() =>
    withTenantHttp(
      db,
      claims,
      db
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
            cursorCondition,
          ),
        )
        .orderBy(asc(classes.startsAt), asc(reservations.id))
        .limit(limit + 1),
    ),
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: ReservationListItem[] = pageRows.map((row) => ({
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

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow !== undefined
      ? encodeCursor({ startsAt: lastRow.classStartsAt.toISOString(), id: lastRow.id })
      : null;

  return { items, nextCursor };
}
