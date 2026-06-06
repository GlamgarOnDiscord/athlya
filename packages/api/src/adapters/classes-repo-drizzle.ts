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

import { classes, reservations } from '@athlya/db/schema';
import { and, asc, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';
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
/*  List repo (member-side calendar query)                             */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `ListClassesRepo` bound to the supplied
 * Drizzle instance. Returns rows ordered `starts_at ASC` so the
 * service does not need to re-sort in JS — the composite index
 * `classes_studio_starts_at_idx` already serves that ordering.
 *
 * Soft-deleted classes are filtered out at the SQL level (Req 7.1).
 */
export function createDrizzleListClassesRepo(db: AthlyaDbAny): ListClassesRepo {
  return {
    async findInRange(studioId: string, range: FindInRangeRange): Promise<ListClassesRow[]> {
      const rows = await withConnectionRetry(() =>
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
      );
      return rows.map(toListClassesRow);
    },
  };
}

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
/*  Create repo (admin-side `POST /v1/classes`)                        */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `CreateClassRepo` bound to the supplied
 * Drizzle instance. Pins `version = 0` (Req 6.1) — the service
 * passes it explicitly, we forward it unchanged.
 */
export function createDrizzleCreateClassRepo(db: AthlyaDbAny): CreateClassRepo {
  return {
    async createClass(input: CreateClassRepoInput): Promise<ClassRow> {
      const [row] = await withConnectionRetry(() =>
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
      );
      if (row === undefined) {
        throw new Error('createClass: Drizzle returned an empty result set');
      }
      return row;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Update repo (admin-side `PATCH /v1/classes/:id`)                   */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces an `UpdateClassRepo` bound to the supplied
 * Drizzle instance. Enforces the optimistic-lock contract:
 *
 *   - `findById` returns the row (or `null` on soft-deleted /
 *     missing) so the service can report `not_found` vs `conflict`.
 *   - `updateClassOptimistic` runs a single SQL statement that
 *     bumps `version` atomically when the guard matches, returns
 *     `null` when `0 rows affected` (stale version → `conflict`).
 *
 * Per the service contract, the UPDATE must also set `version =
 * version + 1` in the same statement (Req 6.7).
 */
/* ------------------------------------------------------------------ */
/*  Delete repo (admin-side `DELETE /v1/classes/:id`)                  */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a delete adapter bound to the supplied Drizzle
 * instance. Performs a soft-delete (sets `deleted_at`) then cancels
 * all `confirmed` and `waitlist` reservations for that class.
 */
export function createDrizzleDeleteClassRepo(db: AthlyaDbAny) {
  return {
    async deleteClass(studioId: string, classId: string): Promise<boolean> {
      // Soft-delete the class row.
      const rows = await withConnectionRetry(() =>
        db
          .update(classes)
          .set({ deletedAt: new Date() })
          .where(
            and(eq(classes.id, classId), eq(classes.studioId, studioId), isNull(classes.deletedAt)),
          )
          .returning(),
      );
      if (rows.length === 0) return false;

      // Cancel active reservations.
      await withConnectionRetry(async () => {
        await db
          .update(reservations)
          .set({ status: 'cancelled', cancelledAt: new Date() })
          .where(
            and(
              eq(reservations.classId, classId),
              inArray(reservations.status, ['confirmed', 'waitlist']),
            ),
          );
      });
      return true;
    },
  };
}

export function createDrizzleUpdateClassRepo(db: AthlyaDbAny): UpdateClassRepo {
  return {
    async findById(classId: string): Promise<ClassRow | null> {
      const rows = await withConnectionRetry(() =>
        db
          .select()
          .from(classes)
          .where(and(eq(classes.id, classId), isNull(classes.deletedAt)))
          .limit(1),
      );
      return rows[0] ?? null;
    },

    async updateClassOptimistic(
      classId: string,
      patch: UpdateClassFields,
      expectedVersion: number,
    ): Promise<ClassRow | null> {
      // Build the SET clause from only the fields the caller
      // supplied. `version` is always bumped by exactly 1
      // (Req 6.7); we do not expose a way to set it
      // explicitly because the service's contract is the
      // optimistic-lock increment.
      const columns: Partial<typeof classes.$inferInsert> = {
        version: expectedVersion + 1,
      };
      if (patch.title !== undefined) {
        columns.title = patch.title;
      }
      if (patch.startsAt !== undefined) {
        columns.startsAt = new Date(patch.startsAt);
      }
      if (patch.durationMin !== undefined) {
        columns.durationMin = patch.durationMin;
      }
      if (patch.capacity !== undefined) {
        columns.capacity = patch.capacity;
      }
      if (patch.coachId !== undefined) {
        // Zod allows `null` to clear the coach assignment.
        columns.coachId = patch.coachId;
      }
      if (patch.description !== undefined) {
        // Zod allows `null` to clear the description.
        columns.description = patch.description;
      }

      const [row] = await withConnectionRetry(() =>
        db
          .update(classes)
          .set(columns)
          .where(
            and(
              eq(classes.id, classId),
              eq(classes.version, expectedVersion),
              isNull(classes.deletedAt),
            ),
          )
          .returning(),
      );
      return row ?? null;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Search repo — GET /v1/classes/search (CN.8.2)                     */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `ClassSearchRepo` bound to the supplied Drizzle
 * instance. Queries the `search_vector` GIN index introduced by
 * migration 0007 via `plainto_tsquery('simple', ?)`.
 *
 * Results are ordered by tsvector rank DESC, then `starts_at ASC` so
 * the most relevant upcoming classes appear first.
 *
 * Soft-deleted classes and classes outside the optional date window are
 * excluded at the SQL level.
 */
export function createDrizzleSearchClassesRepo(db: AthlyaDbAny): ClassSearchRepo {
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
