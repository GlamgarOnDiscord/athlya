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
 *   • Every read/write runs inside {@link withTenant} so the three
 *     `app.*` session variables are set before RLS policies on
 *     `classes` / `reservations` evaluate (Req 13.1–13.6). Application-
 *     layer `WHERE` filters remain as defense-in-depth.
 *
 * @see Requirements 8.1–8.6, 9.1–9.5, 10.1–10.5, 16.3.
 */

import { withTenant, type AthlyaDb, type AthlyaTx, type TenantClaims } from '@athlya/db/client';
import { isPostgresRaiseException, isPostgresUniqueViolation } from '@athlya/db/errors';
import { classes, outbox, reservations } from '@athlya/db/schema';
import { ClassCapacityExceededError, UniqueViolationError } from '@athlya/reservations';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

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
/*  Adapter-boundary cast helpers                                      */
/* ------------------------------------------------------------------ */

/**
 * Cast a Drizzle transaction handle to the service-layer opaque
 * `BookingTx` marker. Used inside `withTransaction` to hand the
 * service an opaque handle it cannot introspect — enforcing that only
 * the adapter (not the service) calls Drizzle APIs.
 *
 * The double-cast is inherent to the opaque-type adapter pattern and
 * intentionally isolated here rather than scattered at every call site.
 */
function toBookingTx(tx: AthlyaTx): BookingTx {
  return tx as unknown as BookingTx;
}

/**
 * Inverse of {@link toBookingTx} — recover the underlying Drizzle
 * transaction from the opaque `BookingTx` handle so the adapter's
 * concrete method implementations can run queries.
 */
function toAthlyaTx(tx: BookingTx): AthlyaTx {
  return tx as unknown as AthlyaTx;
}

/* ------------------------------------------------------------------ */
/*  BookingRepo                                                        */
/* ------------------------------------------------------------------ */

/**
 * Factory — produces a `BookingRepo` bound to the supplied Drizzle
 * instance. Safe to rebuild per-request (see
 * `reservations-deps.ts` for the I/O-isolation rationale).
 */
export function createDrizzleBookingRepo(db: AthlyaDb, claims: TenantClaims): BookingRepo {
  return {
    async findClass(classId): Promise<BookingClassRow | null> {
      return withConnectionRetry(() =>
        withTenant(db, claims, async (tx) => {
          const rows = await tx
            .select({
              id: classes.id,
              studioId: classes.studioId,
              capacity: classes.capacity,
              startsAt: classes.startsAt,
              version: classes.version,
            })
            .from(classes)
            .where(and(eq(classes.id, classId), isNull(classes.deletedAt)))
            .limit(1);
          return rows[0] ?? null;
        }),
      );
    },

    async withTransaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
      return withTenant(db, claims, async (tx) => fn(toBookingTx(tx)));
    },

    async findExistingConfirmedOrWaitlistReservation(
      tx,
      classId,
      userId,
    ): Promise<BookingReservationRow | null> {
      const drizzleTx = toAthlyaTx(tx);
      const rows = await drizzleTx
        .select()
        .from(reservations)
        .where(and(eq(reservations.classId, classId), eq(reservations.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertReservation(tx, input): Promise<BookingReservationRow> {
      const drizzleTx = toAthlyaTx(tx);
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
      await insertOutboxRow(toAthlyaTx(tx), event);
    },

    async countWaitlistAhead(tx, classId, reservationCreatedAt): Promise<number> {
      const drizzleTx = toAthlyaTx(tx);
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
export function createDrizzleCancelRepo(db: AthlyaDb, claims: TenantClaims): CancelRepo {
  return {
    async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return withTenant(db, claims, async (tx) => fn(tx));
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
