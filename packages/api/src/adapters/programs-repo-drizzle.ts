/**
 * Drizzle-backed {@link ProgramRepo} for `/v1/programs/*` — Epic 24,
 * issue #640.
 *
 * RLS posture: every operation runs inside `withTenant` (postgres-js
 * interactive transaction with the caller's `app.*` GUCs), so the
 * migration 0042 policies decide what the caller sees and may write:
 * members only see published programs and the ones they follow, only
 * admins write programs, a user only touches their own subscriptions,
 * and another studio's rows are invisible (surfacing as `null` →
 * 404). The repo never filters by studio itself.
 *
 * Replacing a schedule deletes the program's weeks (their workouts
 * cascade) and re-inserts them in the same transaction as the version
 * bump, so readers never see a half-written program.
 */

import { withTenant } from '@athlya/db/client';
import { isPostgresRaiseException, isPostgresUniqueViolation } from '@athlya/db/errors';
import {
  programSubscriptions,
  programWeeks,
  programWorkouts,
  programs,
  type ProgramRow,
  type ProgramSubscriptionRow,
} from '@athlya/db/schema';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDb, AthlyaTx, TenantClaims } from '@athlya/db/client';
import type {
  ActiveSchedule,
  NewProgram,
  ProgramPatch,
  ProgramRepo,
  ProgramUpdateOutcome,
  SubscribeOutcome,
} from '@athlya/programs';
import type {
  ProgramDetail,
  ProgramSubscription,
  ProgramSummary,
  ProgramWeek,
  ProgramWeekInput,
} from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Row mapping                                                        */
/* ------------------------------------------------------------------ */

function toSummary(row: ProgramRow, weekCount: number): ProgramSummary {
  return {
    id: row.id,
    studioId: row.studioId,
    title: row.title,
    description: row.description,
    status: row.status,
    version: row.version,
    weekCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
}

function toDetail(row: ProgramRow, weeks: ReadonlyArray<ProgramWeek>): ProgramDetail {
  return { ...toSummary(row, weeks.length), weeks: [...weeks] };
}

function toSubscription(
  row: ProgramSubscriptionRow,
  program: { readonly title: string; readonly status: ProgramRow['status'] },
): ProgramSubscription {
  return {
    id: row.id,
    programId: row.programId,
    programTitle: program.title,
    programStatus: program.status,
    startsOn: row.startsOn,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Queries shared by several operations                               */
/* ------------------------------------------------------------------ */

/** Weeks (with workouts) of the given programs, keyed by program id. */
async function loadWeeks(
  tx: AthlyaTx,
  programIds: ReadonlyArray<string>,
): Promise<Map<string, ProgramWeek[]>> {
  const byProgram = new Map<string, ProgramWeek[]>();
  if (programIds.length === 0) return byProgram;

  const weeks = await tx
    .select()
    .from(programWeeks)
    .where(inArray(programWeeks.programId, [...programIds]))
    .orderBy(asc(programWeeks.weekNumber));
  if (weeks.length === 0) return byProgram;

  const workouts = await tx
    .select()
    .from(programWorkouts)
    .where(
      inArray(
        programWorkouts.weekId,
        weeks.map((w) => w.id),
      ),
    )
    .orderBy(asc(programWorkouts.dayNumber));

  for (const week of weeks) {
    const list = byProgram.get(week.programId) ?? [];
    list.push({
      weekNumber: week.weekNumber,
      title: week.title,
      workouts: workouts
        .filter((w) => w.weekId === week.id)
        .map((w) => ({
          id: w.id,
          dayNumber: w.dayNumber,
          title: w.title,
          notes: w.notes,
          exercises: [...w.exercises],
        })),
    });
    byProgram.set(week.programId, list);
  }
  return byProgram;
}

async function loadDetail(tx: AthlyaTx, programId: string): Promise<ProgramDetail | null> {
  const [row] = await tx.select().from(programs).where(eq(programs.id, programId)).limit(1);
  if (row === undefined) return null;
  const weeks = await loadWeeks(tx, [row.id]);
  return toDetail(row, weeks.get(row.id) ?? []);
}

async function insertWeeks(
  tx: AthlyaTx,
  programId: string,
  studioId: string,
  weeks: ReadonlyArray<ProgramWeekInput>,
): Promise<void> {
  if (weeks.length === 0) return;
  const inserted = await tx
    .insert(programWeeks)
    .values(
      weeks.map((w) => ({
        programId,
        studioId,
        weekNumber: w.weekNumber,
        title: w.title === undefined || w.title === '' ? null : w.title,
      })),
    )
    .returning({ id: programWeeks.id, weekNumber: programWeeks.weekNumber });
  const weekIds = new Map(inserted.map((w) => [w.weekNumber, w.id]));

  const workouts = weeks.flatMap((week) =>
    week.workouts.map((workout) => {
      const weekId = weekIds.get(week.weekNumber);
      if (weekId === undefined) {
        throw new Error(`insertWeeks: week ${String(week.weekNumber)} was not inserted`);
      }
      return {
        weekId,
        studioId,
        dayNumber: workout.dayNumber,
        title: workout.title,
        notes: workout.notes === undefined || workout.notes === '' ? null : workout.notes,
        exercises: workout.exercises,
      };
    }),
  );
  if (workouts.length > 0) {
    await tx.insert(programWorkouts).values(workouts);
  }
}

async function findActiveSubscription(
  tx: AthlyaTx,
  programId: string,
  userId: string,
): Promise<ProgramSubscription | null> {
  const [row] = await tx
    .select({ sub: programSubscriptions, title: programs.title, status: programs.status })
    .from(programSubscriptions)
    .innerJoin(programs, eq(programs.id, programSubscriptions.programId))
    .where(
      and(
        eq(programSubscriptions.programId, programId),
        eq(programSubscriptions.userId, userId),
        isNull(programSubscriptions.cancelledAt),
      ),
    )
    .limit(1);
  return row === undefined ? null : toSubscription(row.sub, row);
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Produce a {@link ProgramRepo} bound to `db` and the caller's tenant
 * claims. Cheap to rebuild per request.
 */
export function createDrizzleProgramRepo(db: AthlyaDb, claims: TenantClaims): ProgramRepo {
  /** Read-only transactions are safe to replay after a dropped connection. */
  const read = <T>(fn: (tx: AthlyaTx) => Promise<T>): Promise<T> =>
    withConnectionRetry(() => withTenant(db, claims, fn));

  return {
    list(filter) {
      return read(async (tx) => {
        // Spelled out: Drizzle renders `${programs.id}` unqualified in a
        // select, which the subquery would bind to `w.id`.
        const weekCount = sql<number>`(SELECT count(*)::int FROM program_weeks w WHERE w.program_id = "programs"."id")`;
        const rows = await tx
          .select({ program: programs, weekCount })
          .from(programs)
          .where(filter.status === undefined ? undefined : eq(programs.status, filter.status))
          .orderBy(desc(programs.updatedAt), asc(programs.id));
        return rows.map((r) => toSummary(r.program, Number(r.weekCount)));
      });
    },

    get(programId) {
      return read((tx) => loadDetail(tx, programId));
    },

    create(input: NewProgram) {
      return withTenant(db, claims, async (tx) => {
        const [row] = await tx
          .insert(programs)
          .values({
            studioId: input.studioId,
            createdBy: input.createdBy,
            title: input.title,
            description: input.description,
            status: input.status,
          })
          .returning();
        if (row === undefined) throw new Error('createProgram: insert returned no row');
        await insertWeeks(tx, row.id, row.studioId, input.weeks);
        const detail = await loadDetail(tx, row.id);
        if (detail === null) throw new Error('createProgram: program not readable after insert');
        return detail;
      });
    },

    update(programId, expectedVersion, patch: ProgramPatch) {
      return withTenant(db, claims, async (tx): Promise<ProgramUpdateOutcome> => {
        const [updated] = await tx
          .update(programs)
          .set({
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            version: sql`${programs.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(programs.id, programId),
              eq(programs.version, expectedVersion),
              ne(programs.status, 'archived'),
            ),
          )
          .returning({ id: programs.id, studioId: programs.studioId });

        if (updated === undefined) {
          const [current] = await tx
            .select({ status: programs.status })
            .from(programs)
            .where(eq(programs.id, programId))
            .limit(1);
          if (current === undefined) return { kind: 'not_found' };
          return current.status === 'archived' ? { kind: 'archived' } : { kind: 'conflict' };
        }

        if (patch.weeks !== undefined) {
          await tx.delete(programWeeks).where(eq(programWeeks.programId, programId));
          await insertWeeks(tx, programId, updated.studioId, patch.weeks);
        }
        const program = await loadDetail(tx, programId);
        return program === null ? { kind: 'not_found' } : { kind: 'updated', program };
      });
    },

    archive(programId) {
      return withTenant(db, claims, async (tx) => {
        await tx
          .update(programs)
          .set({
            status: 'archived',
            archivedAt: sql`now()`,
            version: sql`${programs.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(programs.id, programId), ne(programs.status, 'archived')));
        return loadDetail(tx, programId);
      });
    },

    async subscribe(input): Promise<SubscribeOutcome> {
      try {
        return await withTenant(db, claims, async (tx) => {
          const [row] = await tx
            .insert(programSubscriptions)
            .values({
              programId: input.programId,
              studioId: input.studioId,
              userId: input.userId,
              startsOn: input.startsOn,
            })
            .returning();
          if (row === undefined) throw new Error('subscribe: insert returned no row');
          const subscription = await findActiveSubscription(tx, row.programId, row.userId);
          if (subscription === null) throw new Error('subscribe: subscription not readable');
          return { kind: 'subscribed', subscription } as const;
        });
      } catch (err) {
        if (isPostgresRaiseException(err, 'program_not_subscribable')) {
          return { kind: 'not_subscribable' };
        }
        if (!isPostgresUniqueViolation(err)) throw err;
        // A concurrent or earlier subscribe holds the active slot; the
        // failed transaction is gone, so read it in a fresh one.
        const existing = await read((tx) =>
          findActiveSubscription(tx, input.programId, input.userId),
        );
        if (existing === null) throw err;
        return { kind: 'already_subscribed', subscription: existing };
      }
    },

    cancelSubscription(programId, userId) {
      return withTenant(db, claims, async (tx) => {
        const rows = await tx
          .update(programSubscriptions)
          .set({ cancelledAt: sql`now()` })
          .where(
            and(
              eq(programSubscriptions.programId, programId),
              eq(programSubscriptions.userId, userId),
              isNull(programSubscriptions.cancelledAt),
            ),
          )
          .returning({ id: programSubscriptions.id });
        return rows.length > 0;
      });
    },

    listSubscriptions(userId) {
      return read(async (tx) => {
        const rows = await tx
          .select({ sub: programSubscriptions, title: programs.title, status: programs.status })
          .from(programSubscriptions)
          .innerJoin(programs, eq(programs.id, programSubscriptions.programId))
          .where(
            and(eq(programSubscriptions.userId, userId), isNull(programSubscriptions.cancelledAt)),
          )
          .orderBy(asc(programSubscriptions.createdAt), asc(programSubscriptions.id));
        return rows.map((r) => toSubscription(r.sub, r));
      });
    },

    listActiveSchedules(userId) {
      return read(async (tx): Promise<ActiveSchedule[]> => {
        const rows = await tx
          .select({ sub: programSubscriptions, program: programs })
          .from(programSubscriptions)
          .innerJoin(programs, eq(programs.id, programSubscriptions.programId))
          .where(
            and(eq(programSubscriptions.userId, userId), isNull(programSubscriptions.cancelledAt)),
          )
          .orderBy(asc(programSubscriptions.startsOn), asc(programSubscriptions.id));
        const weeks = await loadWeeks(
          tx,
          rows.map((r) => r.program.id),
        );
        return rows.map((r) => ({
          subscription: toSubscription(r.sub, r.program),
          program: toDetail(r.program, weeks.get(r.program.id) ?? []),
        }));
      });
    },
  };
}
