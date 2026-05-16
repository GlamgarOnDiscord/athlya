/**
 * `publish` — transactional-outbox-aware event dispatch.
 *
 * Every Athlya domain service that commits a state change is required
 * by Requirements 16.1–16.3 to emit the corresponding `AthlyaEvent` on
 * the Event_Bus with at-least-once semantics:
 *
 *   • 16.1 — publish on commit.
 *   • 16.2 — if the queue publish fails after the retry budget, insert
 *            the event into the PostgreSQL `outbox` table within the
 *            same transaction as the primary state change.
 *   • 16.3 — if the outbox insert itself fails, the enclosing
 *            transaction rolls back (no "ghost" state with no event).
 *
 * This helper centralises that protocol so domain services never have
 * to re-implement it. Two call modes cover the whole surface:
 *
 *   A. `publish(event, tx, deps)` — transactional mode.
 *      Inserts the event into `outbox` as part of the caller's
 *      transaction BEFORE any queue traffic. If that insert throws,
 *      the error propagates and the caller's transaction rolls back
 *      (Req 16.3). If `deps.queue` is also provided, we then try the
 *      queue with a retry budget; a success produces `'both'`, an
 *      exhaustion produces `'outbox'` (the drain worker from task
 *      9.3 will deliver the outbox row).
 *      Guarantee: **at-least-once delivery, provided the outer
 *      transaction commits**.
 *
 *   B. `publish(event, undefined, deps)` — best-effort mode.
 *      Retries `queue.send` with exponential backoff up to the
 *      configured budget. On full exhaustion, throws
 *      {@link PublishError} so the caller decides (compensating
 *      writes, different fallback, …). No silent swallow.
 *      Guarantee: **best-effort only**. Callers that need durability
 *      must supply a `tx` or persist to outbox themselves.
 *
 * Why outbox-first in transactional mode?
 * ---------------------------------------
 * The design document's §E5 (event bus unavailable) calls out the
 * transactional-outbox pattern as the primary mechanism: the write
 * and the intent-to-publish commit together, and a background drain
 * reconciles with the bus. Attempting the queue before the outbox
 * insert would create a window where a successful queue send could
 * be followed by a failed outbox insert + transaction rollback,
 * producing a "ghost" event that mentions a reservation that never
 * existed — the exact invariant Req 16.3 forbids.
 *
 * Attempting the queue AFTER the outbox insert (as we do here) is
 * strictly dominated in the happy path by a single duplicate delivery
 * if the drain worker later retries the same `event.id`. Consumers
 * already dedup on `event.id` for 24 h (Req 17.4), so duplicates are a
 * non-event.
 */

import { insertOutbox, type OutboxEvent } from '@athlya/db/outbox';
import { InvalidEventError, parseEvent, type AthlyaEvent } from '@athlya/shared/events';

import type { AthlyaTx } from '@athlya/db/client';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal producer shape the helper needs. Matches the Cloudflare
 * Queues binding (`env.EVENTS.send(body)`) and is declared locally so
 * this package doesn't take a runtime dependency on
 * `@cloudflare/workers-types` — the Wrangler-generated binding already
 * satisfies the contract.
 *
 * `message` is typed as `unknown` deliberately: Cloudflare serialises
 * whatever we hand it and the helper itself passes the full
 * {@link AthlyaEvent} envelope.
 *
 * Implementations MUST throw on delivery failure; a resolved promise
 * signals that the bus acknowledged the message.
 */
export interface Queue {
    send(message: unknown): Promise<void>;
}

/**
 * Minimal logger shape. Defaults to `console` so production deploys
 * can inject an Axiom/OTel-aware logger without forcing a dependency.
 */
export interface PublishLogger {
    warn: (msg: string, extra?: Record<string, unknown>) => void;
    error: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Dependencies bundle threaded through {@link publish}. All fields
 * are optional so domain services can keep call sites short.
 *
 *   • `queue`           Cloudflare Queues binding. If omitted, no
 *                       queue traffic is attempted; the transactional
 *                       path still writes to the outbox, the
 *                       best-effort path throws (there is nothing to
 *                       deliver on).
 *   • `maxQueueRetries` Total number of queue `send` attempts per
 *                       call, including the first one. Must be ≥ 1.
 *                       Defaults to {@link DEFAULT_MAX_QUEUE_RETRIES}.
 *   • `retryBackoffMs`  Backoff schedule. Receives the 1-indexed
 *                       attempt that just failed (so the first call
 *                       is `retryBackoffMs(1)`) and returns the delay
 *                       in milliseconds before the next attempt.
 *                       Defaults to {@link DEFAULT_RETRY_BACKOFF}.
 *   • `logger`          Swappable logger. Defaults to `console`.
 */
export interface PublishDeps {
    readonly queue?: Queue;
    readonly maxQueueRetries?: number;
    readonly retryBackoffMs?: (attempt: number) => number;
    readonly logger?: PublishLogger;
}

/**
 * Outcome of a {@link publish} call.
 *
 *   • `'queue'`  — best-effort mode only; the queue accepted the
 *                  event on one of the attempts. No outbox row was
 *                  written (there was no transaction to attach it to).
 *   • `'outbox'` — transactional mode; the outbox row was inserted
 *                  durably and the queue either was not attempted
 *                  (no `deps.queue`) or rejected every retry. The
 *                  drain worker will redeliver.
 *   • `'both'`   — transactional mode; both the outbox row AND the
 *                  queue send succeeded. Consumers dedup on
 *                  `event.id` (Req 17.4) so the redelivery by the
 *                  drain worker is harmless.
 */
export type PublishDelivery = 'queue' | 'outbox' | 'both';

/** Structured result returned by {@link publish}. */
export interface PublishResult {
    readonly delivery: PublishDelivery;
}

/**
 * Thrown on the best-effort (no-`tx`) code path when every retry to
 * {@link Queue.send} has failed, or when the caller provided neither a
 * transaction nor a queue (there is no way to achieve durability).
 *
 * The `code` field is stable (`'publish_failed'`) so callers can
 * discriminate without `instanceof` across bundling boundaries;
 * `cause` carries the last underlying error for observability.
 */
export class PublishError extends Error {
    public override readonly name = 'PublishError';
    /** Stable discriminator. Always `'publish_failed'` for now. */
    public readonly code = 'publish_failed' as const;
    /** The error thrown by the final {@link Queue.send} attempt, if any. */
    public override readonly cause: unknown;
    /** Total number of queue attempts made when the error was raised. */
    public readonly attempts: number;

    public constructor(attempts: number, cause?: unknown) {
        super(
            `publish_failed: queue send exhausted after ${String(attempts)} attempt(s): ${describeCause(cause)}`,
        );
        this.cause = cause;
        this.attempts = attempts;
    }
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Default total number of attempts (initial + retries). */
export const DEFAULT_MAX_QUEUE_RETRIES = 3;

/**
 * Default exponential backoff: `min(2^attempt * 100, 5000) ms`.
 *
 *   attempt=1 →   200 ms
 *   attempt=2 →   400 ms
 *   attempt=3 →   800 ms
 *   attempt=4 →  1 600 ms
 *   attempt=5 →  3 200 ms
 *   attempt≥6 →  5 000 ms (capped)
 *
 * Intentionally deterministic (no jitter): jitter is a fleet-level
 * concern and belongs in the caller's enqueue loop, not in a per-event
 * publisher.
 */
export const DEFAULT_RETRY_BACKOFF = (attempt: number): number =>
    Math.min(2 ** attempt * 100, 5000);

/** Default async sleeper — simple `setTimeout` wrapper. */
const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const defaultLogger: PublishLogger = {
    warn: (msg, extra) => {
        console.warn(`[publish] ${msg}`, extra ?? {});
    },
    error: (msg, extra) => {
        console.error(`[publish] ${msg}`, extra ?? {});
    },
};

/* ------------------------------------------------------------------ */
/*  publish                                                             */
/* ------------------------------------------------------------------ */

/**
 * Publish `event` onto the Event_Bus following the transactional
 * outbox protocol.
 *
 * Validation
 * ----------
 * `event` is parsed through `parseEvent` BEFORE any I/O. A malformed
 * envelope throws {@link InvalidEventError} with a normalised issue
 * list so the router can decide between "DLQ" and "reject the upstream
 * caller".
 *
 * Transactional mode (`tx` provided)
 * ----------------------------------
 *   1. Insert the event into `outbox` **within the caller's
 *      transaction**. If this step throws, the error propagates so the
 *      enclosing transaction rolls back (Req 16.3). No queue traffic
 *      is attempted in that case.
 *   2. If `deps.queue` is provided, attempt {@link Queue.send} up to
 *      `deps.maxQueueRetries` times with the configured backoff.
 *      Success yields `'both'`; exhaustion yields `'outbox'` (the
 *      outbox drain worker, task 9.3, will redeliver).
 *   3. If `deps.queue` is NOT provided, returns `'outbox'` after the
 *      insert.
 *
 * Best-effort mode (no `tx`)
 * --------------------------
 *   1. Requires `deps.queue`. Without it the caller has no durability
 *      option at all, so we throw {@link PublishError} immediately.
 *   2. Try {@link Queue.send} up to `deps.maxQueueRetries` times with
 *      the configured backoff. Returns `'queue'` as soon as one
 *      attempt succeeds.
 *   3. If every attempt fails, throws {@link PublishError}. No outbox
 *      row is written because there is no transaction to attach it to —
 *      the caller is expected to either persist the event via another
 *      mechanism or bubble the error.
 *
 * @throws {@link InvalidEventError} when the event does not match the schema.
 * @throws {@link PublishError} on the best-effort path when every retry fails,
 *   OR when neither `tx` nor `deps.queue` is supplied.
 * @throws the underlying DB error on the transactional path when the
 *   outbox insert fails — propagated so the caller's transaction rolls back.
 */
export async function publish(
    event: AthlyaEvent,
    tx?: AthlyaTx,
    deps: PublishDeps = {},
): Promise<PublishResult> {
    const validated = validate(event);
    const logger = deps.logger ?? defaultLogger;

    if (tx !== undefined) {
        return publishTransactional(validated, tx, deps, logger);
    }

    return publishBestEffort(validated, deps, logger);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run the event through `parseEvent` and throw
 * {@link InvalidEventError} on failure. Separated from {@link publish}
 * so the transactional path can never be reached with a malformed
 * envelope — we want validation failures to surface BEFORE the caller
 * hands us a live transaction handle.
 */
function validate(event: AthlyaEvent): AthlyaEvent {
    // `parseEvent` already throws `InvalidEventError` on failure. No
    // try/catch needed — just forward it.
    return parseEvent(event);
}

/**
 * Transactional path. Outbox-first; queue send is best-effort with
 * retries. Req 16.2 + 16.3.
 */
async function publishTransactional(
    event: AthlyaEvent,
    tx: AthlyaTx,
    deps: PublishDeps,
    logger: PublishLogger,
): Promise<PublishResult> {
    // Step 1: durable record. A failure MUST propagate so the caller's
    // transaction rolls back (Req 16.3). Do not wrap in try/catch.
    await insertOutbox(tx, toOutboxEvent(event));

    // Step 2: optionally try the queue. The outbox row is now part of
    // the caller's transaction, so a queue failure here only costs us
    // a drain-worker delivery delay.
    if (deps.queue === undefined) {
        return { delivery: 'outbox' };
    }

    try {
        await sendWithRetries(deps.queue, event, deps, logger);
        return { delivery: 'both' };
    } catch (err) {
        logger.warn('queue send exhausted on transactional path; relying on outbox drain', {
            eventId: event.id,
            eventType: event.type,
            error: errToDetail(err),
        });
        return { delivery: 'outbox' };
    }
}

/**
 * Best-effort path. Retries `queue.send` with backoff up to the
 * configured budget. Throws {@link PublishError} on full exhaustion
 * or when no queue was supplied.
 */
async function publishBestEffort(
    event: AthlyaEvent,
    deps: PublishDeps,
    logger: PublishLogger,
): Promise<PublishResult> {
    const budget = normaliseBudget(deps.maxQueueRetries);

    if (deps.queue === undefined) {
        // Neither `tx` nor `queue`: the caller has no durability
        // option. Fail loud rather than silently succeed.
        logger.error('publish called without tx and without queue', {
            eventId: event.id,
            eventType: event.type,
        });
        throw new PublishError(0, new Error('no queue configured and no tx provided'));
    }

    try {
        await sendWithRetries(deps.queue, event, deps, logger);
        return { delivery: 'queue' };
    } catch (err) {
        logger.error('queue send exhausted retry budget', {
            eventId: event.id,
            eventType: event.type,
            attempts: budget,
            error: errToDetail(err),
        });
        throw new PublishError(budget, err);
    }
}

/**
 * Try `queue.send(event)` up to `deps.maxQueueRetries` times with the
 * configured backoff between attempts. Resolves on the first success,
 * rejects with the LAST encountered error after the budget is exhausted.
 *
 * The sleeper is a module-local `setTimeout` wrapper; for tests that
 * need to avoid the wall-clock delay, supply `retryBackoffMs: () => 0`
 * — `setTimeout(..., 0)` still resolves on the next macrotask tick.
 */
async function sendWithRetries(
    queue: Queue,
    event: AthlyaEvent,
    deps: PublishDeps,
    logger: PublishLogger,
): Promise<void> {
    const budget = normaliseBudget(deps.maxQueueRetries);
    const backoff = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF;

    let lastError: unknown;
    for (let attempt = 1; attempt <= budget; attempt++) {
        try {
            await queue.send(event);
            return;
        } catch (err) {
            lastError = err;
            logger.warn('queue send attempt failed', {
                eventId: event.id,
                eventType: event.type,
                attempt,
                budget,
                error: errToDetail(err),
            });
            if (attempt < budget) {
                const delay = normaliseDelay(backoff(attempt));
                await defaultSleep(delay);
            }
        }
    }
    throw lastError;
}

/**
 * Convert an {@link AthlyaEvent} into the shape {@link insertOutbox}
 * expects. We pass just the `payload` field (not the full envelope)
 * because the outbox columns (`event_id`, `event_type`, `occurred_at`)
 * already carry the other envelope fields, and the drain worker
 * reassembles an equivalent envelope on republish.
 */
function toOutboxEvent(event: AthlyaEvent): OutboxEvent {
    return {
        eventId: event.id,
        eventType: event.type,
        // `payload` is a plain object on every arm of the discriminated
        // union — spread it to avoid aliasing the schema-validated
        // reference.
        payload: { ...event.payload },
        // `occurredAt` is declared as `IsoDateTimeSchema` (ISO-8601 UTC
        // string) in `@athlya/shared/events`. The outbox helper wants a
        // Date; a single `new Date(...)` is enough because the schema
        // has already validated the format.
        occurredAt: new Date(event.occurredAt),
    };
}

/** Normalise / bound the retry budget. Always ≥ 1. */
function normaliseBudget(raw: number | undefined): number {
    if (raw === undefined) return DEFAULT_MAX_QUEUE_RETRIES;
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
        throw new RangeError(
            `publish: maxQueueRetries must be a positive integer, got ${String(raw)}`,
        );
    }
    return raw;
}

/**
 * Normalise a backoff delay returned by the user-supplied function.
 * Clamps negatives to 0 and rejects non-finite values — a backoff of
 * `NaN` would hang the loop on `setTimeout`.
 */
function normaliseDelay(raw: number): number {
    if (!Number.isFinite(raw)) {
        throw new RangeError(
            `publish: retryBackoffMs returned a non-finite value: ${String(raw)}`,
        );
    }
    return raw < 0 ? 0 : raw;
}

/**
 * Shrink an unknown thrown value into something safe to serialise into
 * logs. Keeps the `name` and `message` of `Error` instances and coerces
 * anything else to its `String()` representation.
 */
function errToDetail(err: unknown): { name?: string; message: string } {
    if (err instanceof Error) {
        return { name: err.name, message: err.message };
    }
    return { message: String(err) };
}

/** Human-readable stringification for {@link PublishError.message}. */
function describeCause(cause: unknown): string {
    if (cause === undefined) return '<unknown>';
    if (cause === null) return 'null';
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }
    switch (typeof cause) {
        case 'string':
            return cause;
        case 'number':
        case 'boolean':
        case 'bigint':
            return cause.toString();
        case 'symbol':
            return cause.toString();
        case 'function':
            return '<function>';
        default:
            // Plain object. `String(cause)` would yield "[object Object]",
            // so fall back to JSON. The try/catch covers circular refs.
            try {
                return JSON.stringify(cause) ?? '<unknown>';
            } catch {
                return '<unserialisable>';
            }
    }
}
