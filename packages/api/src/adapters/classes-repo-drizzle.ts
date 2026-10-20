/**
 * Drizzle-backed adapters for the class-management ports declared in
 * `@athlya/reservations`:
 *
 *   - {@link ListClassesRepo}  — `findInRange` for the member-side
 *     calendar query (`GET /v1/classes`).
 *   - {@link CreateClassRepo}  — `createClass` for admin-side
 *     `POST /v1/classes`.
 *   - {@link UpdateClassRepo}  — `findById` + `updateClassOptimistic`
 *     for admin-side `PATCH /v1/classes/:id`: optimistic locking on
 *     `version`, plus a capacity guard and waitlist promotion run in
 *     one transaction under the class row lock.
 *   - {@link ClassSearchRepo}  — `search` for the FTS endpoint
 *     `GET /v1/classes/search` (CN.8.2, migration 0007).
 *
 * Same transactional posture as the other adapters: every query goes
 * through `withConnectionRetry` so Neon's free-tier suspend-resume
 * doesn't surface as a spurious 500. Rows are filtered on
 * `deleted_at IS NULL` everywhere; a future slice will introduce a
 * soft-undelete flow when the need appears.
 *
 * @see Requirements 6.1, 6.5, 6.6, 6.7, 7.1, CN.8.2.
 */

import { withTenant, withTenantHttp } from '@athlya/db';
import { isPostgresRaiseException } from '@athlya/db/errors';
import { classes, outbox, reservations } from '@athlya/db/schema';
import { and, asc, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import { noteOutboxWrite } from '../events/outbox-kick.js';

import { withConnectionRetry, withTransactionRetry } from './db-retry.js';
import { toDateOrNull } from './service-functions.js';

import type { AthlyaDb, AthlyaDbHttp, AthlyaTx, TenantClaims } from '@athlya/db/client';
import type { ClassRow } from '@athlya/db/schema';
import type {
  ClassRepo as ListClassesRepo,
  ClassRow as ListClassesRow,
  FindInRangeRange,
} from '@athlya/reservations';
import type {
  ClassRepo as CreateClassRepo,
  CreateClassRepoInput,
} from '@athlya/reservations/create';
import type {
  ClassSearchRepo,
  ClassSearchRow,
  ClassSearchRange,
} from '@athlya/reservations/search';
import type {
  GuardedClassUpdate,
  ClassRepo as UpdateClassRepo,
  UpdateClassFields,
} from '@athlya/reservations/update';

/* ------------------------------------------------------------------ */
/*  Row projection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Project the Drizzle row shape onto the service-layer `ClassRow`
 * contract. The two shapes are nearly identical; we enumerate the
 * fields explicitly so any future schema drift (e.g. a new column
 * added to `classes`) surfaces as a TS error here rather than
 * silently leaking into the service.
 */
function toListClassesRow(row: ClassRow): ListClassesRow {
  return {
    id: row.id,
    studioId: row.studioId,
    coachId: row.coachId,
    title: row.title,
    startsAt: row.startsAt,
    durationMin: row.durationMin,
    capacity: row.capacity,
    version: row.version,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP-driver variants                                               */
/* ------------------------------------------------------------------ */

export function createDrizzleListClassesRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): ListClassesRepo {
  return {
    async findInRange(studioId: string, range: FindInRangeRange): Promise<ListClassesRow[]> {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select()
            .from(classes)
            .where(
              and(
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
                between(classes.startsAt, range.from, range.to),
              ),
            )
            .orderBy(asc(classes.startsAt)),
        ),
      );
      return rows.map(toListClassesRow);
    },
  };
}

export function createDrizzleCreateClassRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): CreateClassRepo {
  return {
    async createClass(input: CreateClassRepoInput): Promise<ClassRow> {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .insert(classes)
            .values({
              studioId: input.studioId,
              title: input.title,
              startsAt: new Date(input.startsAt),
              durationMin: input.durationMin,
              capacity: input.capacity,
              version: input.version,
              ...(input.coachId !== undefined ? { coachId: input.coachId } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            })
            .returning(),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('createClass: Drizzle returned an empty result set');
      }
      return row;
    },
  };
}

export function createDrizzleDeleteClassRepoHttp(db: AthlyaDbHttp, claims: TenantClaims) {
  return {
    async deleteClass(studioId: string, classId: string): Promise<boolean> {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(classes)
            .set({ deletedAt: new Date() })
            .where(
              and(
                eq(classes.id, classId),
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
              ),
            )
            .returning(),
        ),
      );
      if (rows.length === 0) return false;

      await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(reservations)
            .set({ status: 'cancelled', cancelledAt: new Date() })
            .where(
              and(
                eq(reservations.classId, classId),
                inArray(reservations.status, ['confirmed', 'waitlist']),
              ),
            ),
        ),
      );
      return true;
    },
  };
}

/**
 * Update adapter. `findById` reads over the HTTP driver; the guarded
 * update needs an interactive transaction (row lock, count, UPDATE,
 * promotions), so it runs on the postgres-js write handle as the
 * admin, under RLS (`classes_update_admin`,
 * `reservations_read_admin_same_studio`, `reservations_update_admin`,
 * `outbox_insert_tenant`).
 */
export function createDrizzleUpdateClassRepo(
  dbHttp: AthlyaDbHttp,
  dbWrite: AthlyaDb,
  claims: TenantClaims,
): UpdateClassRepo {
  return {
    async findById(studioId: string, classId: string): Promise<ClassRow | null> {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          dbHttp,
          claims,
          dbHttp
            .select()
            .from(classes)
            .where(
              and(
                eq(classes.id, classId),
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
              ),
            )
            .limit(1),
        ),
      );
      return rows[0] ?? null;
    },

    async updateClassOptimistic(
      studioId: string,
      classId: string,
      patch: UpdateClassFields,
      expectedVersion: number,
    ): Promise<GuardedClassUpdate> {
      const columns: Partial<typeof classes.$inferInsert> = {
        version: expectedVersion + 1,
      };
      if (patch.title !== undefined) columns.title = patch.title;
      if (patch.startsAt !== undefined) columns.startsAt = new Date(patch.startsAt);
      if (patch.durationMin !== undefined) columns.durationMin = patch.durationMin;
      if (patch.capacity !== undefined) columns.capacity = patch.capacity;
      if (patch.coachId !== undefined) columns.coachId = patch.coachId;
      if (patch.description !== undefined) columns.description = patch.description;

      return withTransactionRetry(() =>
        withTenant(dbWrite, claims, async (tx): Promise<GuardedClassUpdate> => {
          // Same lock `enforce_class_capacity()` takes before every
          // confirmation: no booking commits between the count below
          // and the UPDATE.
          const [current] = await tx
            .select({
              version: classes.version,
              capacity: classes.capacity,
              startsAt: classes.startsAt,
              dbNow: sql<Date | string>`now()`,
            })
            .from(classes)
            .where(
              and(
                eq(classes.id, classId),
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (current?.version !== expectedVersion) {
            return { outcome: 'version_conflict' };
          }

          // The transaction clock, the one `guard_class_schedule()` reads.
          const nowMs = toDateOrNull(current.dbNow)?.getTime() ?? Date.now();
          const newStart = columns.startsAt;
          if (newStart !== undefined && newStart.getTime() !== current.startsAt.getTime()) {
            if (current.startsAt.getTime() <= nowMs) {
              return { outcome: 'class_already_started' };
            }
            if (newStart.getTime() <= nowMs) {
              return { outcome: 'starts_at_in_past' };
            }
          }

          let confirmed = await countOccupied(tx, classId);
          if (patch.capacity !== undefined && patch.capacity < confirmed) {
            return { outcome: 'capacity_below_confirmed', confirmed };
          }

          let row: ClassRow | undefined;
          try {
            [row] = await tx
              .update(classes)
              .set(columns)
              .where(and(eq(classes.id, classId), eq(classes.version, expectedVersion)))
              .returning();
          } catch (err) {
            const refused = guardRefusal(err, confirmed);
            if (refused !== null) return refused;
            throw err;
          }
          if (row === undefined) {
            return { outcome: 'version_conflict' };
          }

          if (patch.capacity !== undefined && row.capacity > confirmed) {
            confirmed += await promoteWaiters(tx, classId, row.capacity - confirmed);
          }
          return { outcome: 'updated', row, confirmed };
        }),
      );
    },
  };
}

/**
 * Occupied seats: confirmed reservations plus unexpired seat holds,
 * the count `enforce_class_capacity()` and `guard_class_schedule()`
 * use (migration 0050). `hold_expires_at` is not in the Drizzle table.
 */
async function countOccupied(tx: AthlyaTx, classId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number | string>`count(*)` })
    .from(reservations)
    .where(
      and(
        eq(reservations.classId, classId),
        sql`(${reservations.status} = 'confirmed'
             OR (${reservations.status} = 'pending' AND hold_expires_at > now()))`,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Map a `guard_class_schedule()` refusal (migration 0050) to the
 * outcome the service checks above would have given. Reached only if
 * the trigger and these checks disagree, so it stays a clean 409/422.
 */
function guardRefusal(err: unknown, confirmed: number): GuardedClassUpdate | null {
  if (isPostgresRaiseException(err, 'class_capacity_below_booked')) {
    return { outcome: 'capacity_below_confirmed', confirmed };
  }
  if (isPostgresRaiseException(err, 'class_already_started')) {
    return { outcome: 'class_already_started' };
  }
  if (isPostgresRaiseException(err, 'class_starts_in_past')) {
    return { outcome: 'starts_at_in_past' };
  }
  return null;
}

/**
 * Promote up to `seats` waiters, oldest first (`created_at`, then `id`,
 * the order `reservation_promote_oldest_waitlist` uses). `SKIP LOCKED`
 * leaves a waiter a concurrent cancel is already promoting to that
 * cancel. The capacity trigger still checks every UPDATE.
 */
async function promoteWaiters(tx: AthlyaTx, classId: string, seats: number): Promise<number> {
  const waiters = await tx
    .select({ id: reservations.id, userId: reservations.userId })
    .from(reservations)
    .where(and(eq(reservations.classId, classId), eq(reservations.status, 'waitlist')))
    .orderBy(asc(reservations.createdAt), asc(reservations.id))
    .limit(seats)
    .for('update', { skipLocked: true });

  for (const waiter of waiters) {
    await tx
      .update(reservations)
      .set({ status: 'confirmed' })
      .where(eq(reservations.id, waiter.id));
    await tx.insert(outbox).values({
      eventId: crypto.randomUUID(),
      eventType: 'reservation.promoted',
      payload: { reservationId: waiter.id, classId, userId: waiter.userId },
      occurredAt: new Date(),
    });
    noteOutboxWrite('reservation.promoted');
  }
  return waiters.length;
}

export function createDrizzleSearchClassesRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): ClassSearchRepo {
  return {
    async search(
      studioId: string,
      query: string,
      range?: ClassSearchRange,
    ): Promise<ClassSearchRow[]> {
      const conditions = [
        eq(classes.studioId, studioId),
        isNull(classes.deletedAt),
        sql`search_vector @@ plainto_tsquery('simple', ${query})`,
        ...(range
          ? [sql`${classes.startsAt} >= ${range.from}`, sql`${classes.startsAt} <= ${range.to}`]
          : []),
      ];

      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select({
              id: classes.id,
              studioId: classes.studioId,
              coachId: classes.coachId,
              title: classes.title,
              description: classes.description,
              startsAt: classes.startsAt,
              durationMin: classes.durationMin,
              capacity: classes.capacity,
              version: classes.version,
              createdAt: classes.createdAt,
            })
            .from(classes)
            .where(and(...conditions))
            .orderBy(
              sql`ts_rank(search_vector, plainto_tsquery('simple', ${query})) DESC`,
              asc(classes.startsAt),
            )
            .limit(50),
        ),
      );

      return rows.map((row) => ({
        id: row.id,
        studioId: row.studioId,
        coachId: row.coachId,
        title: row.title,
        description: row.description,
        startsAt: row.startsAt,
        durationMin: row.durationMin,
        capacity: row.capacity,
        version: row.version,
        createdAt: row.createdAt,
      }));
    },
  };
}
