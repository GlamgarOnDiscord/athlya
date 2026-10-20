/**
 * Drizzle adapters behind studio rooms, weekly class series and
 * schedule conflict detection (issue #748, migration 0051).
 *
 *   - Rooms: list, create, rename / resize, soft delete. Deleting a room
 *     also unassigns it from the classes that have not started yet.
 *   - Series: create every occurrence in one transaction, edit or delete
 *     an occurrence and every later one that has not started.
 *   - Conflicts: the live classes of the studio that share a room or a
 *     coach with the classes being placed, over an overlapping interval.
 *
 * Every function runs on the postgres-js write handle inside
 * {@link withTenant}, so RLS applies (`rooms_*`, `classes_*`,
 * `reservations_*`, `outbox_insert_tenant`) and a multi-statement change
 * commits or rolls back as one. Series edits take the same class row
 * locks and run the same capacity and waitlist steps as the single
 * class update in `classes-repo-drizzle.ts`.
 *
 * The conflict check is advisory: it reads the planning in the same
 * transaction as the write but takes no lock that would stop a
 * concurrent admin from placing a clashing class at the same instant.
 * It exists to warn, the override (`allowConflicts`) is legitimate, and
 * nothing in booking depends on rooms or coaches being exclusive.
 */

import { withTenant } from '@athlya/db';
import { isPostgresRaiseException, isPostgresUniqueViolation } from '@athlya/db/errors';
import { classes, reservations, rooms } from '@athlya/db/schema';
import { ClassId } from '@athlya/shared/ids';
import {
  findScheduleConflicts,
  retimeInZone,
  scheduleWindow,
  type ScheduledClass,
  type ScheduleSlot,
} from '@athlya/shared/schedule';
import { MAX_REPORTED_CONFLICTS } from '@athlya/shared/schemas/api';
import { and, asc, eq, gte, gt, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';

import { countOccupied, promoteWaiters } from './classes-repo-drizzle.js';
import { withTransactionRetry } from './db-retry.js';
import { toDateOrNull } from './service-functions.js';

import type { AthlyaDb, AthlyaTx, TenantClaims } from '@athlya/db/client';
import type { ClassRow, RoomRow } from '@athlya/db/schema';
import type {
  CreateClassSeriesRequest,
  CreateRoomRequest,
  ScheduleConflictItem,
  UpdateClassSeriesRequest,
  UpdateRoomRequest,
} from '@athlya/shared/schemas/api';

/** Longest class the schema accepts, in minutes: bounds the overlap lookup. */
const MAX_DURATION_MIN = 480;

/** Neighbours read for one conflict check; far above a real week of one room. */
const NEIGHBOUR_LIMIT = 2000;

/* ------------------------------------------------------------------ */
/*  Conflicts                                                          */
/* ------------------------------------------------------------------ */

/**
 * Live classes of `studioId` that share a room or a coach with one of
 * `slots` over an overlapping interval, ignoring `ignore` (the classes
 * being moved). Capped at {@link MAX_REPORTED_CONFLICTS}.
 */
export async function findClassConflicts(
  tx: AthlyaTx,
  studioId: string,
  slots: ReadonlyArray<ScheduleSlot>,
  ignore: ReadonlyArray<string> = [],
): Promise<ScheduleConflictItem[]> {
  const window = scheduleWindow(slots);
  const roomIds = [...new Set(slots.flatMap((s) => (s.roomId === null ? [] : [s.roomId])))];
  const coachIds = [...new Set(slots.flatMap((s) => (s.coachId === null ? [] : [s.coachId])))];
  if (window === null || (roomIds.length === 0 && coachIds.length === 0)) return [];

  const sharesResource = or(
    ...(roomIds.length > 0 ? [inArray(classes.roomId, roomIds)] : []),
    ...(coachIds.length > 0 ? [inArray(classes.coachId, coachIds)] : []),
  );
  const rows = await tx
    .select({
      id: classes.id,
      title: classes.title,
      startsAt: classes.startsAt,
      durationMin: classes.durationMin,
      roomId: classes.roomId,
      coachId: classes.coachId,
    })
    .from(classes)
    .where(
      and(
        eq(classes.studioId, studioId),
        isNull(classes.deletedAt),
        lt(classes.startsAt, window.to),
        gt(classes.startsAt, new Date(window.from.getTime() - MAX_DURATION_MIN * 60_000)),
        sharesResource,
        ...(ignore.length > 0 ? [notInArray(classes.id, [...ignore])] : []),
      ),
    )
    .orderBy(asc(classes.startsAt))
    .limit(NEIGHBOUR_LIMIT);

  const existing: ScheduledClass[] = rows.map((row) => ({
    ...row,
    startsAt: toDateOrNull(row.startsAt) ?? row.startsAt,
  }));
  return findScheduleConflicts(slots, existing)
    .slice(0, MAX_REPORTED_CONFLICTS)
    .map((conflict) => ({
      occurrenceStartsAt: (slots[conflict.candidate]?.startsAt ?? window.from).toISOString(),
      classId: ClassId(conflict.existing.id),
      title: conflict.existing.title,
      startsAt: conflict.existing.startsAt.toISOString(),
      durationMin: conflict.existing.durationMin,
      reasons: [...conflict.reasons],
    }));
}

/** Whether `roomId` is a live room of `studioId` (RLS also scopes the read). */
export async function isRoomUsable(
  tx: AthlyaTx,
  studioId: string,
  roomId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.studioId, studioId), isNull(rooms.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** Outcome of the checks that run before a class is created or moved. */
export type PlacementCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'room_not_found' }
  | { readonly kind: 'schedule_conflict'; readonly conflicts: ScheduleConflictItem[] };

/**
 * The room must be a live room of the studio, then (unless the admin
 * overrides) no other class may share the room or the coach over an
 * overlapping interval.
 */
export async function checkPlacement(
  tx: AthlyaTx,
  studioId: string,
  slots: ReadonlyArray<ScheduleSlot>,
  options: { readonly allowConflicts: boolean; readonly ignore?: ReadonlyArray<string> },
): Promise<PlacementCheck> {
  const roomIds = new Set(slots.flatMap((s) => (s.roomId === null ? [] : [s.roomId])));
  for (const roomId of roomIds) {
    if (!(await isRoomUsable(tx, studioId, roomId))) return { kind: 'room_not_found' };
  }
  if (options.allowConflicts) return { kind: 'ok' };
  const conflicts = await findClassConflicts(tx, studioId, slots, options.ignore ?? []);
  return conflicts.length > 0 ? { kind: 'schedule_conflict', conflicts } : { kind: 'ok' };
}

/** {@link checkPlacement} in its own tenant transaction, for the single-class routes. */
export function checkPlacementAsTenant(
  db: AthlyaDb,
  claims: TenantClaims,
  slots: ReadonlyArray<ScheduleSlot>,
  options: { readonly allowConflicts: boolean; readonly ignore?: ReadonlyArray<string> },
): Promise<PlacementCheck> {
  return withTransactionRetry(() =>
    withTenant(db, claims, (tx) => checkPlacement(tx, claims.studioId, slots, options)),
  );
}

/* ------------------------------------------------------------------ */
/*  Rooms                                                              */
/* ------------------------------------------------------------------ */

export type RoomWriteOutcome =
  | { readonly kind: 'ok'; readonly room: RoomRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'name_taken' };

export function createRoomsRepo(db: AthlyaDb, claims: TenantClaims) {
  const studioId = claims.studioId;
  return {
    list(): Promise<RoomRow[]> {
      return withTenant(db, claims, (tx) =>
        tx
          .select()
          .from(rooms)
          .where(and(eq(rooms.studioId, studioId), isNull(rooms.deletedAt)))
          .orderBy(sql`lower(${rooms.name})`, asc(rooms.id)),
      );
    },

    async create(input: CreateRoomRequest): Promise<RoomWriteOutcome> {
      try {
        const [room] = await withTenant(db, claims, (tx) =>
          tx
            .insert(rooms)
            .values({ studioId, name: input.name, capacity: input.capacity ?? null })
            .returning(),
        );
        if (room === undefined) throw new Error('createRoom: empty RETURNING');
        return { kind: 'ok', room };
      } catch (err) {
        if (isPostgresUniqueViolation(err)) return { kind: 'name_taken' };
        throw err;
      }
    },

    async update(roomId: string, patch: UpdateRoomRequest): Promise<RoomWriteOutcome> {
      const columns: Partial<typeof rooms.$inferInsert> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.capacity !== undefined) columns.capacity = patch.capacity;
      try {
        const [room] = await withTenant(db, claims, (tx) =>
          tx
            .update(rooms)
            .set(columns)
            .where(and(eq(rooms.id, roomId), eq(rooms.studioId, studioId), isNull(rooms.deletedAt)))
            .returning(),
        );
        return room === undefined ? { kind: 'not_found' } : { kind: 'ok', room };
      } catch (err) {
        if (isPostgresUniqueViolation(err)) return { kind: 'name_taken' };
        throw err;
      }
    },

    /**
     * Soft-delete the room and unassign it from the live classes that
     * have not started (their `version` moves so an open edit form gets
     * a clean 409). Past classes keep the room for the record.
     */
    remove(roomId: string): Promise<{ readonly kind: 'deleted' | 'not_found' }> {
      return withTransactionRetry(() =>
        withTenant(db, claims, async (tx) => {
          const [room] = await tx
            .update(rooms)
            .set({ deletedAt: sql`now()` })
            .where(and(eq(rooms.id, roomId), eq(rooms.studioId, studioId), isNull(rooms.deletedAt)))
            .returning({ id: rooms.id });
          if (room === undefined) return { kind: 'not_found' as const };
          await tx
            .update(classes)
            .set({ roomId: null, version: sql`${classes.version} + 1` })
            .where(
              and(
                eq(classes.roomId, roomId),
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
                gt(classes.startsAt, sql`now()`),
              ),
            );
          return { kind: 'deleted' as const };
        }),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Series                                                             */
/* ------------------------------------------------------------------ */

export type CreateSeriesOutcome =
  | { readonly kind: 'created'; readonly seriesId: string; readonly rows: ClassRow[] }
  | { readonly kind: 'starts_at_in_past' }
  | Exclude<PlacementCheck, { readonly kind: 'ok' }>;

export type UpdateSeriesOutcome =
  | {
      readonly kind: 'updated';
      readonly rows: ClassRow[];
      /** Free seats to write back to the Redis counter, per class whose capacity changed. */
      readonly remaining: ReadonlyMap<string, number>;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict' }
  | { readonly kind: 'class_already_started' }
  | { readonly kind: 'starts_at_in_past' }
  | { readonly kind: 'capacity_below_confirmed'; readonly classId: string }
  | Exclude<PlacementCheck, { readonly kind: 'ok' }>;

export type DeleteSeriesOutcome =
  { readonly kind: 'deleted'; readonly count: number } | { readonly kind: 'not_found' };

/** Thrown inside a series transaction to roll it back with an outcome. */
class SeriesAbort extends Error {
  public constructor(public readonly outcome: UpdateSeriesOutcome) {
    super(outcome.kind);
  }
}

/** The transaction clock, the one `guard_class_schedule()` reads. */
async function dbNow(tx: AthlyaTx): Promise<number> {
  // postgres-js resolves to an array of rows, PGlite (tests) to `{ rows }`.
  const result: unknown = await tx.execute(sql`select now() as now`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    now: Date | string;
  }>;
  return toDateOrNull(rows[0]?.now ?? null)?.getTime() ?? Date.now();
}

export function createSeriesRepo(db: AthlyaDb, claims: TenantClaims) {
  const studioId = claims.studioId;

  /** The live occurrence `classId` of `seriesId`, locked. */
  async function anchorOf(
    tx: AthlyaTx,
    seriesId: string,
    classId: string,
  ): Promise<ClassRow | undefined> {
    const [anchor] = await tx
      .select()
      .from(classes)
      .where(
        and(
          eq(classes.id, classId),
          eq(classes.seriesId, seriesId),
          eq(classes.studioId, studioId),
          isNull(classes.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    return anchor;
  }

  return {
    /** Insert one class per start instant, all sharing a new series id. */
    create(
      input: CreateClassSeriesRequest,
      starts: ReadonlyArray<Date>,
    ): Promise<CreateSeriesOutcome> {
      const seriesId = crypto.randomUUID();
      return withTransactionRetry(() =>
        withTenant(db, claims, async (tx): Promise<CreateSeriesOutcome> => {
          const now = await dbNow(tx);
          if (starts.some((start) => start.getTime() <= now)) return { kind: 'starts_at_in_past' };
          const slots = starts.map((startsAt) => ({
            startsAt,
            durationMin: input.durationMin,
            roomId: input.roomId ?? null,
            coachId: input.coachId ?? null,
          }));
          const check = await checkPlacement(tx, studioId, slots, {
            allowConflicts: input.allowConflicts === true,
          });
          if (check.kind !== 'ok') return check;

          const rows = await tx
            .insert(classes)
            .values(
              starts.map((startsAt) => ({
                studioId,
                title: input.title,
                startsAt,
                durationMin: input.durationMin,
                capacity: input.capacity,
                version: 0,
                seriesId,
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.coachId !== undefined ? { coachId: input.coachId } : {}),
                ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
              })),
            )
            .returning();
          rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
          return { kind: 'created', seriesId, rows };
        }),
      );
    },

    /**
     * Apply `patch` to the occurrence `fromClassId` and every later one
     * that has not started, all or nothing. The anchor carries the
     * optimistic-lock version the admin saw; every row moves its own
     * version forward.
     */
    async update(seriesId: string, patch: UpdateClassSeriesRequest): Promise<UpdateSeriesOutcome> {
      try {
        return await withTransactionRetry(() =>
          withTenant(db, claims, async (tx): Promise<UpdateSeriesOutcome> => {
            const anchor = await anchorOf(tx, seriesId, patch.fromClassId);
            if (anchor === undefined) return { kind: 'not_found' };
            if (anchor.version !== patch.version) return { kind: 'version_conflict' };
            const now = await dbNow(tx);
            if (anchor.startsAt.getTime() <= now) return { kind: 'class_already_started' };

            const targets = await tx
              .select()
              .from(classes)
              .where(
                and(
                  eq(classes.seriesId, seriesId),
                  eq(classes.studioId, studioId),
                  isNull(classes.deletedAt),
                  gte(classes.startsAt, anchor.startsAt),
                ),
              )
              .orderBy(asc(classes.startsAt))
              .for('update');

            const planned = targets.map((row) => {
              const startsAt =
                patch.startTime !== undefined && patch.timeZone !== undefined
                  ? retimeInZone(row.startsAt, patch.startTime, patch.timeZone)
                  : row.startsAt;
              return {
                row,
                startsAt,
                durationMin: patch.durationMin ?? row.durationMin,
                roomId: patch.roomId !== undefined ? patch.roomId : row.roomId,
                coachId: patch.coachId !== undefined ? patch.coachId : row.coachId,
              };
            });
            if (planned.some((p) => p.startsAt.getTime() <= now)) {
              return { kind: 'starts_at_in_past' };
            }

            const occupied = new Map<string, number>();
            if (patch.capacity !== undefined) {
              for (const { row } of planned) {
                const taken = await countOccupied(tx, row.id);
                if (patch.capacity < taken) {
                  return { kind: 'capacity_below_confirmed', classId: row.id };
                }
                occupied.set(row.id, taken);
              }
            }

            const check = await checkPlacement(tx, studioId, planned, {
              allowConflicts: patch.allowConflicts === true,
              ignore: planned.map((p) => p.row.id),
            });
            if (check.kind !== 'ok') return check;

            const updated: ClassRow[] = [];
            const remaining = new Map<string, number>();
            for (const p of planned) {
              const [row] = await tx
                .update(classes)
                .set({
                  version: p.row.version + 1,
                  startsAt: p.startsAt,
                  durationMin: p.durationMin,
                  roomId: p.roomId,
                  coachId: p.coachId,
                  ...(patch.title !== undefined ? { title: patch.title } : {}),
                  ...(patch.description !== undefined ? { description: patch.description } : {}),
                  ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
                })
                .where(and(eq(classes.id, p.row.id), eq(classes.version, p.row.version)))
                .returning();
              if (row === undefined) throw new SeriesAbort({ kind: 'version_conflict' });
              updated.push(row);
              const taken = occupied.get(row.id);
              if (taken !== undefined) {
                const promoted =
                  row.capacity > taken ? await promoteWaiters(tx, row.id, row.capacity - taken) : 0;
                remaining.set(row.id, Math.max(0, row.capacity - taken - promoted));
              }
            }
            return { kind: 'updated', rows: updated, remaining };
          }),
        );
      } catch (err) {
        if (err instanceof SeriesAbort) return err.outcome;
        if (isPostgresRaiseException(err, 'class_already_started')) {
          return { kind: 'class_already_started' };
        }
        if (isPostgresRaiseException(err, 'class_starts_in_past')) {
          return { kind: 'starts_at_in_past' };
        }
        throw err;
      }
    },

    /**
     * Soft-delete the occurrence `fromClassId` and every later one, and
     * cancel their confirmed and waitlisted reservations, like the single
     * class delete does for one class.
     */
    remove(seriesId: string, fromClassId: string): Promise<DeleteSeriesOutcome> {
      return withTransactionRetry(() =>
        withTenant(db, claims, async (tx): Promise<DeleteSeriesOutcome> => {
          const anchor = await anchorOf(tx, seriesId, fromClassId);
          if (anchor === undefined) return { kind: 'not_found' };
          const deleted = await tx
            .update(classes)
            .set({ deletedAt: sql`now()` })
            .where(
              and(
                eq(classes.seriesId, seriesId),
                eq(classes.studioId, studioId),
                isNull(classes.deletedAt),
                gte(classes.startsAt, anchor.startsAt),
              ),
            )
            .returning({ id: classes.id });
          const ids = deleted.map((d) => d.id);
          if (ids.length > 0) {
            await tx
              .update(reservations)
              .set({ status: 'cancelled', cancelledAt: new Date() })
              .where(
                and(
                  inArray(reservations.classId, ids),
                  inArray(reservations.status, ['confirmed', 'waitlist']),
                ),
              );
          }
          return { kind: 'deleted', count: ids.length };
        }),
      );
    },
  };
}
