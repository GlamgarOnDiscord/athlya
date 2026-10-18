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
 *     `no_waiter` when none is available.
 *
 *   • Cross-member reads and writes go through SECURITY DEFINER
 *     functions (migration 0040, issue #117). Under `athlya_app` with
 *     member claims, `reservations_read_own` / `reservations_update_own`
 *     hide and protect the other members' waitlist rows, and a locking
 *     read of `classes` must pass `classes_update_admin`. The class
 *     lock, the waitlist position and the promotion therefore call
 *     `reservation_lock_class_for_cancel`, `reservation_waitlist_ahead`
 *     and `reservation_promote_oldest_waitlist`, in the same
 *     transaction, each scoped to the caller's studio and to a class
 *     the caller holds a reservation on.
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
import { and, eq, isNull, sql } from 'drizzle-orm';

import { noteOutboxWrite } from '../events/outbox-kick.js';

import { withConnectionRetry } from './db-retry.js';
import { toDateOrNull } from './service-functions.js';

import type { ReservationRow } from '@athlya/db/schema';
import type {
  BookingClassRow,
  BookingEventPublisher,
  BookingOutboxEvent,
  BookingRepo,
  BookingReservationRow,
  BookingTx,
} from '@athlya/reservations';
import type {
  CancelOutboxEvent,
  CancelRepo,
  ClassForCancel,
  WaitlistPromotion,
} from '@athlya/reservations/cancel';

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
      // The other waiters are hidden by `reservations_read_own`; the
      // function counts them for a class the caller is waitlisted on.
      const rows = await toAthlyaTx(tx).execute<{ ahead: number | string | null }>(
        sql`SELECT reservation_waitlist_ahead(${classId}::uuid, ${reservationCreatedAt.toISOString()}::timestamptz) AS ahead`,
      );
      return Number(rows[0]?.ahead ?? 0);
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
 *   - `findClassForUpdate`: `reservation_lock_class_for_cancel` locks
 *     the class row (`FOR UPDATE`) so the `startsAt` read and the
 *     decision "inside 2h window or not" happen against the same
 *     snapshot the UPDATE commits against.
 *   - `promoteOldestWaitlist`: `reservation_promote_oldest_waitlist`
 *     takes the oldest waiter with `FOR UPDATE SKIP LOCKED` so two
 *     cancels racing to promote see different rows (one promotes,
 *     the other gets `no_waiter` and increments the Redis counter
 *     instead), then re-checks capacity before promoting.
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
      const rows = await (tx as AthlyaTx).execute<{ starts_at: Date | string | null }>(
        sql`SELECT reservation_lock_class_for_cancel(${classId}::uuid) AS starts_at`,
      );
      const startsAt = toDateOrNull(rows[0]?.starts_at ?? null);
      return startsAt === null ? null : { startsAt };
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

    async promoteOldestWaitlist(tx, classId): Promise<WaitlistPromotion> {
      // The function holds the class row lock that the capacity
      // trigger also takes, so a concurrent booking cannot fill the
      // seat between its capacity check and the promotion.
      const rows = await (tx as AthlyaTx).execute<{
        outcome: string;
        reservation_id: string | null;
        user_id: string | null;
      }>(
        sql`SELECT outcome, reservation_id, user_id FROM reservation_promote_oldest_waitlist(${classId}::uuid)`,
      );
      const row = rows[0];
      if (row?.outcome === 'promoted' && row.reservation_id !== null && row.user_id !== null) {
        return {
          outcome: 'promoted',
          reservation: { id: row.reservation_id, classId, userId: row.user_id },
        };
      }
      if (row?.outcome === 'no_capacity') return { outcome: 'no_capacity' };
      if (row?.outcome === 'no_waiter') return { outcome: 'no_waiter' };
      throw new Error(`promoteOldestWaitlist: unexpected outcome ${String(row?.outcome)}`);
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
  noteOutboxWrite(event.eventType);
}
