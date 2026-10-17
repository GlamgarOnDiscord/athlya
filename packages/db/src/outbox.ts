/**
 * Transactional outbox helpers.
 *
 * Backs the "transactional outbox" pattern used whenever a domain
 * service needs to publish an event atomically with its state change:
 *
 *   • Requirement 16.1 — the domain service publishes on the Event_Bus
 *     in the happy path.
 *   • Requirement 16.2 — if publish fails after the retry budget, the
 *     event is persisted into `outbox` inside the primary transaction,
 *     so either both the state change and the event are durable or
 *     neither is (Req 16.3).
 *   • Requirement 16.4 — a separate drain worker republishes pending
 *     rows every 30 seconds until they stick.
 *
 * Three entry points cover the lifecycle:
 *
 *   1. {@link insertOutbox} — enqueue an event. Idempotent on
 *      `event_id` via `ON CONFLICT DO NOTHING`, so a retry that repeats
 *      the same `(eventId)` never ends up with two rows.
 *   2. {@link claimBatch} — drain worker's `SELECT … FOR UPDATE SKIP
 *      LOCKED` pull. Skipping locked rows lets multiple drain workers
 *      run in parallel without stepping on each other. The row's
 *      `attempts` counter is bumped eagerly so a crash after the
 *      `SELECT` but before the publish still records the attempt.
 *   3. {@link markPublished} / {@link markFailed} — post-publish
 *      stamping. `markPublished` sets `published_at = now()`, which
 *      makes the row disappear from the `outbox_pending_idx` partial
 *      index; `markFailed` is a no-op on the row (the counter was
 *      already bumped by {@link claimBatch}), so the DLQ policy in the
 *      drain worker can decide what to do with chronically failing
 *      events.
 *
 * Why raw SQL here and not the drizzle query-builder?
 *   `FOR UPDATE SKIP LOCKED` is not yet surfaced as a first-class
 *   chainable API on drizzle-orm 0.45 for Postgres, and this module is
 *   on the hot path of the event bus — keeping the statement literal
 *   lets us audit it directly against the design document. The `sql`
 *   tagged template still parameterises every interpolated value, so
 *   the SQL-injection surface is identical to the builder variant.
 *
 * Related requirements: 16.1, 16.2, 16.3, 16.4.
 */

import { sql } from 'drizzle-orm';

import { DbError } from './errors.js';

import type { AthlyaDb, AthlyaTx } from './client.js';

/** Maximum batch size the drain worker may request in a single pull. */
const MAX_CLAIM_LIMIT = 1000;
/** Default batch size — matches the design document's drain worker. */
const DEFAULT_CLAIM_LIMIT = 50;

/** RFC 4122 UUID v1–8 with variant bits. Used for `id` validation in `markPublished`/`markFailed`. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Thrown when one of the helper inputs fails basic shape validation.
 * Surfaces as {@link DbError} at the API boundary.
 */
export class InvalidOutboxInputError extends DbError {
  public constructor(field: string, reason: string) {
    super('invalid_outbox_input', `invalid outbox input "${field}": ${reason}`);
    this.name = 'InvalidOutboxInputError';
  }
}

/**
 * Public event shape accepted by {@link insertOutbox}. Matches the
 * discriminated union declared in `@athlya/shared/events` (task 9.1)
 * but is intentionally loose here so the schema package can own the
 * canonical types without creating an import cycle.
 */
export interface OutboxEvent {
  /** Domain-level event identifier (UUID v4/v7). Unique across the cluster. */
  readonly eventId: string;
  /** Dotted event name, e.g. `"reservation.created"`. */
  readonly eventType: string;
  /** Fully-serialised event payload. */
  readonly payload: Record<string, unknown>;
  /** Domain timestamp of the underlying state change. */
  readonly occurredAt: Date;
}

/** Snapshot returned by {@link countPendingOutbox}. */
export interface OutboxPendingSnapshot {
  readonly pending: number;
  readonly oldestOccurredAt: Date | null;
}

/** Claimed row returned by {@link claimBatch}. Shape mirrors the wire columns. */
export interface ClaimedOutboxRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly attempts: number;
  /** NULL for rows predating migration 0014. Drain handler should log a warning. */
  readonly studioId: string | null;
}

/**
 * Raw row shape returned by postgres-js for the claim query.
 *
 * Declared as an `interface` with an explicit `[key: string]: unknown`
 * index signature rather than as an intersection with `Record<string,
 * unknown>` — see the matching rationale on `IdempotencyRowRaw` in
 * `./idempotency.ts`. Drizzle's `tx.execute<T>()` requires `T extends
 * Record<string, unknown>`, and the interface form satisfies that
 * constraint directly without relying on intersection assignability
 * quirks.
 */
interface ClaimedOutboxRowRaw {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  studio_id: string | null;
  [key: string]: unknown;
}

/** Row returned by {@link claimLeasedBatch}: the claimed row plus its lease token. */
export interface LeasedOutboxRow extends ClaimedOutboxRow {
  /** `lease_until` of the claim, as text, for {@link releaseLeases} fencing. */
  readonly leaseToken: string;
}

interface LeasedOutboxRowRaw extends ClaimedOutboxRowRaw {
  lease_token: string;
}

/**
 * Insert an event into the outbox as part of the caller's transaction.
 *
 * - `published_at` defaults to `NULL`, so the row is immediately
 *   eligible for the drain worker.
 * - `attempts` starts at `0`; {@link claimBatch} increments it.
 * - `ON CONFLICT (event_id) DO NOTHING` ensures a retry that tries to
 *   insert the same `event_id` is a no-op — matching Req 16.2's
 *   expectation that the outbox is idempotent on event identity.
 *
 * This helper only accepts an {@link AthlyaTx}, not a bare {@link AthlyaDb},
 * because Req 16.3 mandates that the insertion share the caller's
 * transaction — any helper that could quietly open its own transaction
 * would break that invariant.
 */
export async function insertOutbox(tx: AthlyaTx, event: OutboxEvent): Promise<void> {
  validateEvent(event);

  const serialisedPayload = JSON.stringify(event.payload);

  await tx.execute(sql`
        INSERT INTO outbox (event_id, event_type, payload, occurred_at, published_at, attempts)
        VALUES (
            ${event.eventId},
            ${event.eventType},
            ${serialisedPayload}::jsonb,
            ${event.occurredAt.toISOString()},
            NULL,
            0
        )
        ON CONFLICT (event_id) DO NOTHING
    `);
}

/**
 * Claim up to `limit` pending events for publication.
 *
 * Uses a CTE + `FOR UPDATE SKIP LOCKED` pattern so:
 *   - multiple drain workers can run concurrently without contending
 *     on the same rows (SKIP LOCKED),
 *   - the `attempts` counter is bumped atomically with the selection
 *     so an intervening crash never under-counts retries,
 *   - rows are returned oldest-first (`ORDER BY occurred_at ASC`) so
 *     delivery preserves causal ordering per event type on average.
 *
 * Callers MUST commit the transaction after publishing the events —
 * committing without calling {@link markPublished} leaves the rows
 * locked only until the transaction ends, and the next claim will pick
 * them up again (with `attempts` incremented, which is what the DLQ
 * policy consumes).
 */
export async function claimBatch(
  tx: AthlyaTx,
  limit: number = DEFAULT_CLAIM_LIMIT,
): Promise<ClaimedOutboxRow[]> {
  validateLimit(limit);

  // The inner SELECT holds a row-level lock on each returned row
  // (FOR UPDATE). SKIP LOCKED asks Postgres to skip rows that another
  // transaction already locked, which is exactly the cooperative
  // behaviour the drain worker needs.
  const result = await tx.execute<ClaimedOutboxRowRaw>(sql`
        WITH claimed AS (
            SELECT id
              FROM outbox
             WHERE published_at IS NULL
             ORDER BY occurred_at ASC
             LIMIT ${limit}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox
           SET attempts = outbox.attempts + 1
          FROM claimed
         WHERE outbox.id = claimed.id
        RETURNING outbox.id,
                  outbox.event_id,
                  outbox.event_type,
                  outbox.payload,
                  outbox.occurred_at,
                  outbox.attempts,
                  outbox.studio_id
    `);

  const rows = result as unknown as readonly ClaimedOutboxRowRaw[];
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    studioId: row.studio_id,
  }));
}

/**
 * Claim up to `limit` pending rows under a lease (issue #424).
 *
 * One autocommit statement: rows are selected with `FOR UPDATE SKIP
 * LOCKED`, get `attempts + 1` and `lease_until = now() + leaseSeconds`,
 * and the locks are released as soon as the statement commits. The
 * caller sends OUTSIDE any transaction; until the lease expires no
 * other drain can claim the rows, and a drain that dies mid-batch
 * simply lets the lease lapse.
 *
 * Every row of one claim shares the same `lease_until`; its exact text
 * form is returned as `leaseToken` so {@link releaseLeases} only touches
 * rows this claim still owns.
 *
 * `priorityEventTypes` are claimed before any other pending row
 * (issue #311): a notification backlog can never starve compliance
 * events such as `auth.user.deleted`.
 */
export async function claimLeasedBatch(
  db: AthlyaDb,
  limit: number,
  leaseSeconds: number,
  priorityEventTypes: readonly string[] = [],
): Promise<LeasedOutboxRow[]> {
  validateLimit(limit);
  priorityEventTypes.forEach(validateEventType);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new InvalidOutboxInputError('leaseSeconds', 'must be an integer in [1, 3600]');
  }

  const result = await db.execute<LeasedOutboxRowRaw>(sql`
        WITH claimed AS (
            SELECT id
              FROM outbox
             WHERE published_at IS NULL
               AND (lease_until IS NULL OR lease_until <= now())
             ORDER BY (event_type = ANY(${`{${priorityEventTypes.join(',')}}`}::text[])) DESC,
                      occurred_at ASC
             LIMIT ${limit}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox
           SET attempts = outbox.attempts + 1,
               lease_until = now() + make_interval(secs => ${leaseSeconds})
          FROM claimed
         WHERE outbox.id = claimed.id
        RETURNING outbox.id,
                  outbox.event_id,
                  outbox.event_type,
                  outbox.payload,
                  outbox.occurred_at,
                  outbox.attempts,
                  outbox.studio_id,
                  outbox.lease_until::text AS lease_token
    `);

  const rows = result as unknown as readonly LeasedOutboxRowRaw[];
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    studioId: row.studio_id,
    leaseToken: row.lease_token,
  }));
}

/** Pending rows and oldest pending timestamp per event type (issue #311 lane metrics). */
export async function countPendingOutboxByType(
  db: AthlyaDb,
): Promise<Array<{ eventType: string; pending: number; oldestOccurredAt: Date | null }>> {
  interface Row {
    event_type: string;
    pending: number;
    oldest_occurred_at: Date | string | null;
    [key: string]: unknown;
  }
  const result = await db.execute<Row>(sql`
        SELECT event_type, COUNT(*)::int AS pending, MIN(occurred_at) AS oldest_occurred_at
          FROM outbox
         WHERE published_at IS NULL
         GROUP BY event_type
    `);
  return (result as unknown as readonly Row[]).map((row) => ({
    eventType: row.event_type,
    pending: row.pending,
    oldestOccurredAt: row.oldest_occurred_at === null ? null : new Date(row.oldest_occurred_at),
  }));
}

/** Stamp `published_at` on every delivered row of a leased batch in one statement. */
export async function markPublishedMany(db: AthlyaDb, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  ids.forEach(validateId);
  await db.execute(sql`
        UPDATE outbox
           SET published_at = now(), lease_until = NULL
         WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])
    `);
}

/**
 * Release the lease of rows the drain claimed but did not attempt (cycle
 * deadline reached), so the next cycle can claim them without waiting
 * for the lease to lapse. The claim's `attempts + 1` is undone because
 * the row was never sent.
 *
 * Fenced on `leaseToken`: a drain that stalled past its lease must not
 * clear (or decrement) a lease another drain has taken since.
 */
export async function releaseLeases(
  db: AthlyaDb,
  ids: readonly string[],
  leaseToken: string,
): Promise<void> {
  if (ids.length === 0) return;
  ids.forEach(validateId);
  await db.execute(sql`
        UPDATE outbox
           SET lease_until = NULL,
               attempts = GREATEST(outbox.attempts - 1, 0)
         WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])
           AND published_at IS NULL
           AND lease_until = ${leaseToken}::timestamptz
    `);
}

/**
 * Stamp `published_at = now()` on the row, removing it from the
 * `outbox_pending_idx` partial index and therefore from the drain
 * worker's working set.
 *
 * Safe to call with a plain {@link AthlyaDb} instance — the write is a
 * single-row `UPDATE`, so the caller does not need to hold an open
 * transaction at this point.
 */
/**
 * Count unpublished outbox rows and the oldest pending `occurred_at`.
 *
 * Used by the drain worker (adaptive batch sizing) and the admin
 * `/admin/outbox/stats` surface. Callers on the HTTP path should run
 * this inside {@link withTenant} with `role = 'admin'` so RLS allows
 * the read; the scheduled drain uses a BYPASSRLS service connection.
 */
export async function countPendingOutbox(db: AthlyaDb): Promise<OutboxPendingSnapshot> {
  interface PendingCountRow {
    pending: number;
    oldest_occurred_at: Date | null;
    [key: string]: unknown;
  }

  const result = await db.execute<PendingCountRow>(sql`
        SELECT COUNT(*)::int AS pending,
               MIN(occurred_at) AS oldest_occurred_at
          FROM outbox
         WHERE published_at IS NULL
    `);

  const row = (result as unknown as readonly PendingCountRow[])[0];
  if (row === undefined) {
    return { pending: 0, oldestOccurredAt: null };
  }

  return {
    pending: row.pending,
    oldestOccurredAt: row.oldest_occurred_at,
  };
}

export async function markPublished(tx: AthlyaTx | AthlyaDb, id: string): Promise<void> {
  validateId(id);

  await tx.execute(sql`
        UPDATE outbox
           SET published_at = now()
         WHERE id = ${id}
    `);
}

/**
 * Record a failed publish attempt.
 *
 * No SQL is emitted: `attempts` was already incremented by
 * {@link claimBatch} and `published_at` must remain `NULL` so the row
 * is re-claimed on the next drain cycle. The helper still takes a
 * transaction handle so the drain worker's call sites read uniformly
 * (`await markPublished(tx, id)` / `await markFailed(tx, id)`) and so
 * that a future implementation can grow an audit hook without changing
 * the signature.
 *
 * A circuit-breaker policy (e.g. move to DLQ after 5 consecutive
 * failures) lives in the drain worker itself (task 9.3), not here —
 * keeping the SQL layer dumb makes the DLQ threshold tunable without a
 * DB migration.
 */
// Declared `async` on purpose even though the body performs no SQL:
//   - `validateId` throws synchronously, and our test suite asserts
//     via `await expect(markFailed(...)).rejects.toBeInstanceOf(...)`
//     which requires the invocation to return a Promise rather than
//     throw before one is constructed.
//   - The call sites in the drain worker read uniformly as
//     `await markPublished(tx, id)` / `await markFailed(tx, id)`.
//   - Leaves room for an audit-log hook here without changing the
//     signature again.
// The trailing `await Promise.resolve()` is the cheapest operation
// that satisfies `@typescript-eslint/require-await`; a synthetic yield
// to the microtask queue is acceptable on the failure path.
export async function markFailed(tx: AthlyaTx, id: string): Promise<void> {
  validateId(id);
  // Reference `tx` so the linter does not flag the parameter as
  // unused; this keeps the signature stable for future growth.
  void tx;
  await Promise.resolve();
}

function validateEvent(event: OutboxEvent): void {
  if (event === null || typeof event !== 'object') {
    throw new InvalidOutboxInputError('event', 'must be an object');
  }
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new InvalidOutboxInputError('event.eventId', 'must be a non-empty string');
  }
  if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
    throw new InvalidOutboxInputError('event.eventType', 'must be a non-empty string');
  }
  if (event.payload === null || typeof event.payload !== 'object') {
    throw new InvalidOutboxInputError('event.payload', 'must be a plain object');
  }
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    throw new InvalidOutboxInputError('event.occurredAt', 'must be a valid Date');
  }
}

function validateLimit(limit: number): void {
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    !Number.isInteger(limit) ||
    limit <= 0
  ) {
    throw new InvalidOutboxInputError('limit', `must be a positive integer, got ${String(limit)}`);
  }
  if (limit > MAX_CLAIM_LIMIT) {
    throw new InvalidOutboxInputError(
      'limit',
      `must be ≤ ${String(MAX_CLAIM_LIMIT)}, got ${String(limit)}`,
    );
  }
}

/** Dotted event types only — they are inlined into an array literal. */
const EVENT_TYPE_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

function validateEventType(eventType: string): void {
  if (typeof eventType !== 'string' || !EVENT_TYPE_REGEX.test(eventType)) {
    throw new InvalidOutboxInputError('eventType', 'must be a dotted lowercase event type');
  }
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new InvalidOutboxInputError('id', 'must be a UUID');
  }
}
