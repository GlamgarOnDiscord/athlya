/**
 * `CalendarDeps` bundle for `/v1/calendar/*` (issue #719): signs the
 * member's feed URL and reads the bookings a feed token points to.
 *
 * Every read runs through {@link withTenantHttp} with tenant claims, as
 * `GET /v1/reservations/me` does, so the `users_read_own`,
 * `reservations_read_own`, `classes_read_same_studio` and
 * `studios_read_own_tenant` policies apply. For the public feed the
 * claims come from the verified token, with the least privileged role
 * (`member`): even a token minted for an admin only ever reads that
 * person's own bookings.
 *
 * A token is honoured only while the member's row is live, still in the
 * token's studio and on the same `credentials_version` (see
 * `calendar-feed-token.ts`).
 */

import { withTenantHttp } from '@athlya/db';
import { sql } from 'drizzle-orm';

import {
  buildCalendarFeedUrls,
  isCalendarFeedKeyConfigured,
  signCalendarFeedToken,
  verifyCalendarFeedToken,
} from './calendar-feed-token.js';
import { withConnectionRetry } from './db-retry.js';
import { getOrCreateDbHttpForRegion } from './deps-cache.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { CalendarDeps, CalendarFeedEvent } from '../routes/calendar.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';

/** Past bookings kept in the feed, so a class just attended does not vanish. */
const FEED_LOOKBACK_DAYS = 7;
/** Horizon of the feed, aligned with the class listing cap. */
const FEED_LOOKAHEAD_DAYS = 90;
/** Upper bound on events per feed; far above a member's realistic bookings. */
const FEED_MAX_EVENTS = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Feed rows as read for one member, before the token version check. */
export interface CalendarFeedSnapshot {
  readonly credentialsVersion: number;
  readonly studioName: string;
  readonly events: readonly CalendarFeedEvent[];
}

/** Driver-independent reads (raw SQL, ISO strings) so PGlite tests run them as is. */
export interface CalendarFeedRepo {
  /** `credentials_version` of the live member row, or `null`. */
  readCredentialsVersion(claims: TenantClaims): Promise<number | null>;
  /** The member's feed window, or `null` when the member or studio is gone. */
  readFeed(claims: TenantClaims, now: Date): Promise<CalendarFeedSnapshot | null>;
}

interface CredentialsRow {
  credentials_version: unknown;
}

interface FeedRow extends CredentialsRow {
  studio_name: unknown;
  reservation_id: unknown;
  class_id: unknown;
  status: unknown;
  created_at: unknown;
  cancelled_at: unknown;
  title: unknown;
  starts_at: unknown;
  duration_min: unknown;
  class_version: unknown;
  class_deleted_at: unknown;
}

function rowsOf<T>(result: unknown): readonly T[] {
  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as readonly T[]) : [];
}

const isoUtc = (column: string) =>
  sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

const toDate = (value: unknown): Date | null =>
  typeof value === 'string' ? new Date(value) : null;

/**
 * Map the joined rows to feed events. A member may cancel then book the
 * same class again: the live booking supersedes the cancelled one, which
 * would otherwise show as a struck-through duplicate. A deleted class is
 * cancelled for whoever had booked it.
 */
function toEvents(rows: readonly FeedRow[]): CalendarFeedEvent[] {
  const bookings = rows.filter((row) => typeof row.reservation_id === 'string');
  const liveClassIds = new Set(
    bookings.filter((row) => row.status === 'confirmed').map((row) => String(row.class_id)),
  );
  const events: CalendarFeedEvent[] = [];
  for (const row of bookings) {
    const startsAt = toDate(row.starts_at);
    const createdAt = toDate(row.created_at);
    if (startsAt === null || createdAt === null) continue;
    if (row.status !== 'confirmed' && liveClassIds.has(String(row.class_id))) continue;
    const classDeletedAt = toDate(row.class_deleted_at);
    events.push({
      reservationId: String(row.reservation_id),
      classTitle: String(row.title),
      startsAt,
      durationMin: Number(row.duration_min),
      classVersion: Number(row.class_version),
      status: row.status === 'confirmed' && classDeletedAt === null ? 'confirmed' : 'cancelled',
      updatedAt: toDate(row.cancelled_at) ?? classDeletedAt ?? createdAt,
    });
  }
  return events;
}

/** Build the feed reads over a Neon HTTP handle. */
export function createCalendarFeedRepoHttp(db: AthlyaDbHttp): CalendarFeedRepo {
  return {
    async readCredentialsVersion(claims) {
      const result: unknown = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.execute(sql`
            SELECT credentials_version
              FROM users
             WHERE id = ${claims.userId}::uuid
               AND studio_id = ${claims.studioId}::uuid
               AND deleted_at IS NULL
             LIMIT 1
          `),
        ),
      );
      const row = rowsOf<CredentialsRow>(result)[0];
      return row === undefined ? null : Number(row.credentials_version);
    },

    async readFeed(claims, now) {
      const from = new Date(now.getTime() - FEED_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
      const to = new Date(now.getTime() + FEED_LOOKAHEAD_DAYS * MS_PER_DAY).toISOString();
      // One round trip: the member row (version check), the studio name
      // and the bookings in the window, LEFT JOINed so a member without
      // bookings still gets an empty, named calendar.
      const result: unknown = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.execute(sql`
            SELECT u.credentials_version,
                   s.name AS studio_name,
                   r.id AS reservation_id,
                   r.class_id,
                   r.status::text AS status,
                   ${isoUtc('r.created_at')} AS created_at,
                   ${isoUtc('r.cancelled_at')} AS cancelled_at,
                   c.title,
                   ${isoUtc('c.starts_at')} AS starts_at,
                   c.duration_min,
                   c.version AS class_version,
                   ${isoUtc('c.deleted_at')} AS class_deleted_at
              FROM users u
              JOIN studios s
                ON s.id = u.studio_id
               AND s.deleted_at IS NULL
              LEFT JOIN (reservations r
                         JOIN classes c
                           ON c.id = r.class_id
                          AND c.studio_id = ${claims.studioId}::uuid
                          AND c.starts_at >= ${from}::timestamptz
                          AND c.starts_at <= ${to}::timestamptz)
                ON r.user_id = u.id
               AND r.status IN ('confirmed', 'cancelled')
             WHERE u.id = ${claims.userId}::uuid
               AND u.studio_id = ${claims.studioId}::uuid
               AND u.deleted_at IS NULL
             ORDER BY c.starts_at ASC NULLS LAST, r.id ASC
             LIMIT ${FEED_MAX_EVENTS}
          `),
        ),
      );
      const rows = rowsOf<FeedRow>(result);
      const first = rows[0];
      if (first === undefined) return null;
      return {
        credentialsVersion: Number(first.credentials_version),
        studioName: String(first.studio_name),
        events: toEvents(rows),
      };
    },
  };
}

/** Build the production `CalendarDeps` from the Worker bindings. */
export function buildCalendarDeps(
  env: AthlyaBindings,
  cf?: { readonly continent?: string },
): CalendarDeps {
  const repo = (): CalendarFeedRepo =>
    createCalendarFeedRepoHttp(getOrCreateDbHttpForRegion(env, cf?.continent));

  return {
    async getFeedUrl(claims: AuthClaims) {
      const secret = env.CALENDAR_FEED_SIGNING_KEY;
      const baseUrl = env.API_PUBLIC_URL ?? '';
      if (!isCalendarFeedKeyConfigured(secret) || baseUrl === '') {
        return { kind: 'not_configured' };
      }
      const credentialsVersion = await repo().readCredentialsVersion({
        userId: claims.userId,
        studioId: claims.studioId,
        role: claims.role,
      });
      if (credentialsVersion === null) return { kind: 'not_found' };
      const token = await signCalendarFeedToken(secret, {
        memberId: claims.userId,
        studioId: claims.studioId,
        credentialsVersion,
      });
      return { kind: 'ok', ...buildCalendarFeedUrls(baseUrl, token) };
    },

    async getFeed(token: string) {
      const secret = env.CALENDAR_FEED_SIGNING_KEY;
      if (!isCalendarFeedKeyConfigured(secret)) return { kind: 'not_configured' };
      const subject = await verifyCalendarFeedToken(secret, token);
      if (subject === null) return { kind: 'not_found' };
      const snapshot = await repo().readFeed(
        { userId: subject.memberId, studioId: subject.studioId, role: 'member' },
        new Date(),
      );
      if (snapshot === null || snapshot.credentialsVersion !== subject.credentialsVersion) {
        return { kind: 'not_found' };
      }
      return {
        kind: 'ok',
        feed: { studioName: snapshot.studioName, events: snapshot.events },
      };
    },
  };
}
