/**
 * Drizzle-backed adapters for the class-management ports declared in
 * `@athlya/reservations`:
 *
 *   - {@link ListClassesRepo}  — `findInRange` for the member-side
 *     calendar query (`GET /v1/classes`).
 *   - {@link CreateClassRepo}  — `createClass` for admin-side
 *     `POST /v1/classes`.
 *   - {@link UpdateClassRepo}  — `findById` + `updateClassOptimistic`
 *     for admin-side `PATCH /v1/classes/:id` with optimistic locking
 *     on the `version` column.
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

import { withTenantHttp } from '@athlya/db';
import { classes, reservations } from '@athlya/db/schema';
import { and, asc, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
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
import type { ClassRepo as UpdateClassRepo, UpdateClassFields } from '@athlya/reservations/update';

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

export function createDrizzleUpdateClassRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): UpdateClassRepo {
  return {
    async findById(studioId: string, classId: string): Promise<ClassRow | null> {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
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
    ): Promise<ClassRow | null> {
      const columns: Partial<typeof classes.$inferInsert> = {
        version: expectedVersion + 1,
      };
      if (patch.title !== undefined) columns.title = patch.title;
      if (patch.startsAt !== undefined) columns.startsAt = new Date(patch.startsAt);
      if (patch.durationMin !== undefined) columns.durationMin = patch.durationMin;
      if (patch.capacity !== undefined) columns.capacity = patch.capacity;
      if (patch.coachId !== undefined) columns.coachId = patch.coachId;
      if (patch.description !== undefined) columns.description = patch.description;

      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(classes)
            .set(columns)
            .where(
              and(
                eq(classes.id, classId),
                eq(classes.studioId, studioId),
                eq(classes.version, expectedVersion),
                isNull(classes.deletedAt),
              ),
            )
            .returning(),
        ),
      );
      return rows[0] ?? null;
    },
  };
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
