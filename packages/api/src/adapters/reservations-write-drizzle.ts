/**
 * Drizzle-backed write adapters for `@athlya/reservations`:
 *
 *   - {@link createDrizzleBookingRepo}   — `BookingRepo` for
 *     `bookClass` (Algorithm 1 of design.md).
 *   - {@link createDrizzleCancelRepo}    — `CancelRepo` for
 *     `cancelReservation` (Algorithm 2).
 *
 * Every transaction goes through Drizzle's `db.transaction(async tx
 * => …)` callback, which opens a `BEGIN … COMMIT | ROLLBACK` frame
 * around the repo's work. The service layer (book.ts / cancel.ts)
 * owns the orchestration; this adapter is strictly I/O.
 *
 * Key design points:
 *
 *   • `SELECT FOR UPDATE`: cancel path locks the reservation + class
 *     rows so a concurrent cancel racing on the same row serialises
 *     on the first commit. `SKIP LOCKED` on the waitlist-promotion
 *     query avoids a deadlock between two cancels fighting for the
 *     same promoted seat — each cancel sees a different row, or
 *     `null` when none is available.
 *
 *   • `UNIQUE(class_id, user_id)` violation is detected on `.code
 *     === '23505'` (Postgres SQLSTATE 23505). We rethrow as
 *     `UniqueViolationError` with `.code = 'UNIQUE_VIOLATION'` so
 *     the service's permissive detector matches.
 *
 *   • Outbox insert goes through the same transaction as the
 *     reservation write — commit-together or rollback-together
 *     semantics (Req 16.3).
 *
 *   • No `withTenant` wrapping here: the gateway's `jwtAuth` +
 *     `projectUserIdFromClaims` already scope the caller to a single
 *     `userId`, and every read in the cancel path filters explicitly
 *     on `reservations.user_id = $userId` (see
 *     `findReservationForUpdate`) and `reservations.class_id = $classId`
 *     for the booking pre-flight. The booking insert relies on the
 *     `UNIQUE(class_id, user_id)` constraint to detect duplicates.
 *     The RLS policies on `reservations` /  `classes` installed in
 *     `0001_rls.sql` (FORCEd on `athlya_app` by `0004_rls_hardening.sql`)
 *     are the defense-in-depth backstop.
 *
 *     The interactive `db.transaction(async tx => …)` form used for
 *     `bookClass` and `cancelReservation` requires a postgres-js
 *     handle (the HTTP driver only supports static statement
 *     arrays); a future slice may move the transaction-internal
 *     `SET LOCAL app.user_id` injection here so RLS is fully active
 *     during the FOR UPDATE window. Until then, the application-
 *     layer `userId` filter is the primary check.
 *
 * @see Requirements 8.1–8.6, 9.1–9.5, 10.1–10.5, 16.3.
 */

import { isPostgresRaiseException, isPostgresUniqueViolation } from '@athlya/db/errors';
import { classes, outbox, reservations } from '@athlya/db/schema';
import { ClassCapacityExceededError, UniqueViolationError } from '@athlya/reservations';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDb, AthlyaTx } from '@athlya/db/client';
import type { ReservationRow } from '@athlya/db/schema';
import type {
  BookingClassRow,
  BookingEventPublisher,
  BookingOutboxEvent,
  BookingRepo,
  BookingReservationRow,
  BookingTx,
} from '@athlya/reservations';
import type { CancelOutboxEvent, CancelRepo, ClassForCancel } from '@athlya/reservations/cancel';

/* ------------------------------------------------------------------ */
/*  BookingRepo                                                        */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `BookingRepo` bound to the supplied Drizzle
 * instance. Safe to rebuild per-request (see
 * `reservations-deps.ts` for the I/O-isolation rationale).
 */
export function createDrizzleBookingRepo(db: AthlyaDb): BookingRepo {
  return {
    async findClass(classId): Promise<BookingClassRow | null> {
      const rows = await withConnectionRetry(() =>
        db
          .select({
            id: classes.id,
            studioId: classes.studioId,
            capacity: classes.capacity,
            startsAt: classes.startsAt,
            version: classes.version,
          })
          .from(classes)
          .where(and(eq(classes.id, classId), isNull(classes.deletedAt)))
          .limit(1),
      );
      return rows[0] ?? null;
    },

    async withTransaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => fn(tx as unknown as BookingTx));
    },

    async findExistingConfirmedOrWaitlistReservation(
      tx,
      classId,
      userId,
    ): Promise<BookingReservationRow | null> {
      const drizzleTx = tx as unknown as AthlyaTx;
      const rows = await drizzleTx
        .select()
        .from(reservations)
        .where(and(eq(reservations.classId, classId), eq(reservations.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertReservation(tx, input): Promise<BookingReservationRow> {
      const drizzleTx = tx as unknown as AthlyaTx;
      try {
        const [row] = await drizzleTx
          .insert(reservations)
          .values({
            classId: input.classId,
            userId: input.userId,
            status: input.status,
          })
          .returning();
        if (row === undefined) {
          throw new Error('insertReservation: Drizzle returned empty result');
        }
        return row;
      } catch (err) {
        if (isPostgresUniqueViolation(err)) {
          // Re-throw as the domain sentinel so the book
          // service's `isUniqueViolation` matches.
          throw new UniqueViolationError();
        }
        if (isPostgresRaiseException(err, 'class_capacity_exceeded')) {
          throw new ClassCapacityExceededError();
        }
        throw err;
      }
    },

    async insertOutbox(tx, event): Promise<void> {
      await insertOutboxRow(tx as unknown as AthlyaTx, event);
    },

    async countWaitlistAhead(tx, classId, reservationCreatedAt): Promise<number> {
      const drizzleTx = tx as unknown as AthlyaTx;
      const result = await drizzleTx
        .select({ count: sql<number>`count(*)::int` })
        .from(reservations)
        .where(
          and(
            eq(reservations.classId, classId),
            eq(reservations.status, 'waitlist'),
            lt(reservations.createdAt, reservationCreatedAt),
          ),
        );
      return Number(result[0]?.count ?? 0);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  CancelRepo                                                         */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `CancelRepo` bound to the supplied Drizzle
 * instance.
 *
 * Locking strategy (Algorithm 2 §Step 2-3):
 *   - `findReservationForUpdate`: `SELECT ... FOR UPDATE` narrows
 *     concurrent cancels of the same row to one winner.
 *   - `findClassForUpdate`: `SELECT ... FOR UPDATE` pins the class
 *     row so the `startsAt` read and the decision "inside 2h window
 *     or not" happen against the same snapshot the UPDATE commits
 *     against.
 *   - `findOldestWaitlistForClass`: `SELECT ... FOR UPDATE SKIP
 *     LOCKED LIMIT 1` so two cancels racing to promote see
 *     different rows (one promotes, the other gets `null` and
 *     increments the Redis counter instead).
 */
export function createDrizzleCancelRepo(db: AthlyaDb): CancelRepo {
  return {
    async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => fn(tx));
    },

    async findReservationForUpdate(tx, reservationId, userId): Promise<ReservationRow | null> {
      const drizzleTx = tx as AthlyaTx;
      const rows = await drizzleTx
        .select()
        .from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.userId, userId)))
        .for('update')
        .limit(1);
      return rows[0] ?? null;
    },

    async findClassForUpdate(tx, classId): Promise<ClassForCancel | null> {
      const drizzleTx = tx as AthlyaTx;
      const rows = await drizzleTx
        .select({ startsAt: classes.startsAt })
        .from(classes)
        .where(and(eq(classes.id, classId), isNull(classes.deletedAt)))
        .for('update')
        .limit(1);
      return rows[0] ?? null;
    },

    async updateReservationStatus(tx, reservationId, status, stampedAt): Promise<ReservationRow> {
      const drizzleTx = tx as AthlyaTx;
      const set: Partial<typeof reservations.$inferInsert> = { status };
      if (status === 'cancelled') {
        set.cancelledAt = stampedAt;
      }
      try {
        const [row] = await drizzleTx
          .update(reservations)
          .set(set)
          .where(eq(reservations.id, reservationId))
          .returning();
        if (row === undefined) {
          throw new Error(`updateReservationStatus: reservation ${reservationId} not found`);
        }
        return row;
      } catch (err) {
        if (isPostgresRaiseException(err, 'class_capacity_exceeded')) {
          throw new ClassCapacityExceededError();
        }
        throw err;
      }
    },

    async findOldestWaitlistForClass(tx, classId): Promise<ReservationRow | null> {
      const drizzleTx = tx as AthlyaTx;
      // `SKIP LOCKED` is the critical flag for Algorithm 2 —
      // see cancel.ts for the full invariant.
      const rows = await drizzleTx
        .select()
        .from(reservations)
        .where(and(eq(reservations.classId, classId), eq(reservations.status, 'waitlist')))
        .orderBy(asc(reservations.createdAt))
        .for('update', { skipLocked: true })
        .limit(1);
      return rows[0] ?? null;
    },

    async classHasCapacityForConfirmed(tx, classId): Promise<boolean> {
      const drizzleTx = tx as AthlyaTx;
      const [row] = await drizzleTx
        .select({
          capacity: classes.capacity,
          confirmed: sql<number>`(
            SELECT count(*)::int
              FROM ${reservations}
             WHERE class_id = ${classId}
               AND status = 'confirmed'
          )`,
        })
        .from(classes)
        .where(and(eq(classes.id, classId), isNull(classes.deletedAt)))
        .limit(1);
      if (row === undefined) {
        return false;
      }
      return Number(row.confirmed) < row.capacity;
    },

    async insertOutbox(tx, event: CancelOutboxEvent): Promise<void> {
      await insertOutboxRow(tx as AthlyaTx, {
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
        occurredAt: event.occurredAt,
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Event publisher                                                    */
/* ------------------------------------------------------------------ */

/**
 * Builds `BookingOutboxEvent` envelopes with fresh UUIDs and a
 * consistent `occurredAt`. Stateless and cheap — a single instance
 * per adapter assembly is fine.
 */
export function createBookingEventPublisher(): BookingEventPublisher {
  return {
    buildReservationCreated(input): BookingOutboxEvent {
      return {
        eventId: crypto.randomUUID(),
        eventType: 'reservation.created',
        occurredAt: new Date(),
        payload: {
          reservationId: input.reservationId,
          classId: input.classId,
          userId: input.userId,
          studioId: input.studioId,
        },
      };
    },
    buildReservationWaitlisted(input): BookingOutboxEvent {
      return {
        eventId: crypto.randomUUID(),
        eventType: 'reservation.waitlisted',
        occurredAt: new Date(),
        payload: {
          reservationId: input.reservationId,
          classId: input.classId,
          userId: input.userId,
          studioId: input.studioId,
          position: input.position,
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Common outbox insert used by both book and cancel repos. Accepts a
 * pre-built envelope and writes it inside the supplied transaction
 * so commit/rollback semantics are aligned with the reservation row.
 *
 * The `payload` is typed as `object` so callers may pass any
 * `interface` describing a JSON-serialisable record (e.g.
 * `CancelLifecyclePayload`) without a `Record<string, unknown>` cast
 * — Drizzle's `jsonb` column accepts any JSON-encodable value.
 */
async function insertOutboxRow(
  tx: AthlyaTx,
  event: {
    readonly eventId: string;
    readonly eventType: string;
    readonly payload: object;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.insert(outbox).values({
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload as Record<string, unknown>,
    occurredAt: event.occurredAt,
  });
}
