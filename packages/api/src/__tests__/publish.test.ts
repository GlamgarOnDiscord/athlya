/**
 * Unit tests for the publish-with-outbox helper.
 *
 * The module is exercised through direct function calls — no Hono
 * pipeline is needed because the helper is a plain service primitive.
 * The DB boundary (`@athlya/db/outbox.insertOutbox`) is replaced with a
 * `vi.mock` so no Postgres is required.
 *
 * Scenarios covered, mirroring the task description:
 *   1. With `tx` + `queue`: outbox insert runs first, queue succeeds,
 *      result is `{ delivery: 'both' }`.
 *   2. With `tx`, no `queue`: result is `{ delivery: 'outbox' }`.
 *   3. With `tx` + `queue` that keeps failing: outbox still succeeds,
 *      queue exhausts retries silently, result is
 *      `{ delivery: 'outbox' }` (drain worker will deliver).
 *   4. With `tx` + `insertOutbox` throwing: error propagates so the
 *      caller's transaction rolls back; the queue is NEVER touched.
 *   5. Without `tx`, queue succeeds first try: `{ delivery: 'queue' }`.
 *   6. Without `tx`, queue fails every retry: throws {@link PublishError}
 *      with `code === 'publish_failed'`.
 *   7. Without `tx` and without `queue`: throws {@link PublishError}
 *      because there is no durability option.
 *   8. Malformed event → throws {@link InvalidEventError} BEFORE any I/O.
 */

import { InvalidEventError, parseEvent, type AthlyaEvent } from '@athlya/shared/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MAX_QUEUE_RETRIES,
    publish,
    PublishError,
    type PublishDeps,
    type PublishLogger,
    type Queue,
} from '../events/publish.js';

import type { AthlyaTx } from '@athlya/db/client';

// The publish helper calls `insertOutbox` from `@athlya/db/outbox`
// exactly once per transactional invocation. We mock the whole module
// so the test never hits a real Postgres client; `vi.hoisted` keeps the
// mocks addressable from inside the test bodies.
const dbMocks = vi.hoisted(() => ({
    insertOutbox: vi.fn(),
}));

vi.mock('@athlya/db/outbox', () => ({
    insertOutbox: dbMocks.insertOutbox,
}));

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the happy-path fixture through `parseEvent` so the branded
 * domain IDs (`StudioId`, `UserId`, `ClassId`, `ReservationId`) end up
 * with the correct compile-time tags without manual casts.
 */
const VALID_EVENT: AthlyaEvent = parseEvent({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'reservation.created',
    occurredAt: '2025-01-01T12:00:00.000Z',
    studioId: '00000000-0000-4000-8000-0000000000a0',
    payload: {
        reservationId: '00000000-0000-4000-8000-000000000010',
        classId: '00000000-0000-4000-8000-000000000020',
        userId: '00000000-0000-4000-8000-000000000030',
    },
});

/** Build a silent logger so test output stays readable. */
function silentLogger(): PublishLogger {
    return { warn: vi.fn(), error: vi.fn() };
}

/**
 * Build a fake queue whose `send` implementation is backed by a
 * `vi.fn`. The wrapper returns both the queue and the spy so tests
 * can assert call counts without reaching into `queue.send` via
 * `as unknown as`.
 */
function fakeQueue(send: Queue['send']): { queue: Queue; spy: Queue['send'] } {
    const spy = vi.fn(send);
    return { queue: { send: spy }, spy };
}

/**
 * Placeholder transaction handle. The helper never dereferences any
 * method on `tx`; it is only forwarded to the mocked `insertOutbox`.
 * The `as unknown as AthlyaTx` cast keeps the types happy without
 * having to construct a real drizzle transaction.
 */
const FAKE_TX = { __brand: 'fake-tx' } as unknown as AthlyaTx;

/**
 * Zero-delay backoff so retry tests do not pay wall-clock cost. The
 * helper still awaits `setTimeout(..., 0)`, which yields to the next
 * macrotask — effectively instant.
 */
const zeroBackoff: PublishDeps['retryBackoffMs'] = () => 0;

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
    dbMocks.insertOutbox.mockReset();
    dbMocks.insertOutbox.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ */
/*  Transactional path                                                 */
/* ------------------------------------------------------------------ */

describe('publish — transactional path (tx provided)', () => {
    it('writes to outbox first then sends to the queue, returning "both"', async () => {
        const order: string[] = [];
        dbMocks.insertOutbox.mockImplementationOnce(async () => {
            order.push('outbox');
            return Promise.resolve();
        });
        const { queue, spy } = fakeQueue(async () => {
            order.push('queue');
            return Promise.resolve();
        });
        const logger = silentLogger();

        const result = await publish(VALID_EVENT, FAKE_TX, {
            queue,
            retryBackoffMs: zeroBackoff,
            logger,
        });

        expect(result).toEqual({ delivery: 'both' });
        // Outbox MUST be attempted before the queue so a subsequent
        // rollback cannot leave a "ghost" event on the bus (Req 16.3).
        expect(order).toEqual(['outbox', 'queue']);
        expect(dbMocks.insertOutbox).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(VALID_EVENT);

        // The outbox helper receives a Date, not an ISO string.
        const call = dbMocks.insertOutbox.mock.calls[0] as unknown as [
            AthlyaTx,
            { eventId: string; eventType: string; occurredAt: Date },
        ];
        expect(call[0]).toBe(FAKE_TX);
        expect(call[1].eventId).toBe(VALID_EVENT.id);
        expect(call[1].eventType).toBe(VALID_EVENT.type);
        expect(call[1].occurredAt).toBeInstanceOf(Date);
        expect(call[1].occurredAt.toISOString()).toBe(VALID_EVENT.occurredAt);
    });

    it('returns "outbox" when no queue is supplied', async () => {
        const result = await publish(VALID_EVENT, FAKE_TX, {
            logger: silentLogger(),
        });

        expect(result).toEqual({ delivery: 'outbox' });
        expect(dbMocks.insertOutbox).toHaveBeenCalledTimes(1);
    });

    it('swallows queue failures but returns "outbox" after exhausting retries', async () => {
        const { queue, spy } = fakeQueue(() => Promise.reject(new Error('queues are down')));
        const logger = silentLogger();

        const result = await publish(VALID_EVENT, FAKE_TX, {
            queue,
            maxQueueRetries: 3,
            retryBackoffMs: zeroBackoff,
            logger,
        });

        expect(result).toEqual({ delivery: 'outbox' });
        expect(dbMocks.insertOutbox).toHaveBeenCalledTimes(1);
        // All three attempts were consumed before falling back to outbox.
        expect(spy).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledWith(
            'queue send exhausted on transactional path; relying on outbox drain',
            expect.objectContaining({
                eventId: VALID_EVENT.id,
                eventType: VALID_EVENT.type,
                error: expect.objectContaining({ message: 'queues are down' }) as unknown,
            }),
        );
    });

    it('propagates outbox insert errors so the caller transaction rolls back', async () => {
        const boom = new Error('outbox constraint violation');
        dbMocks.insertOutbox.mockRejectedValueOnce(boom);

        const { queue, spy } = fakeQueue(async () => Promise.resolve());

        await expect(
            publish(VALID_EVENT, FAKE_TX, { queue, retryBackoffMs: zeroBackoff }),
        ).rejects.toBe(boom);

        // If the outbox insert fails we MUST NOT touch the queue: doing
        // so after the primary transaction rolls back would leak an
        // event with no durable record backing it.
        expect(spy).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  Best-effort path                                                   */
/* ------------------------------------------------------------------ */

describe('publish — best-effort path (no tx)', () => {
    it('returns "queue" when the queue send succeeds on the first attempt', async () => {
        const { queue, spy } = fakeQueue(async () => Promise.resolve());

        const result = await publish(VALID_EVENT, undefined, {
            queue,
            retryBackoffMs: zeroBackoff,
            logger: silentLogger(),
        });

        expect(result).toEqual({ delivery: 'queue' });
        expect(spy).toHaveBeenCalledTimes(1);
        // No outbox insert on the best-effort path.
        expect(dbMocks.insertOutbox).not.toHaveBeenCalled();
    });

    it('retries transient failures and still returns "queue" on eventual success', async () => {
        let attempts = 0;
        const { queue, spy } = fakeQueue(async () => {
            attempts += 1;
            if (attempts < 2) throw new Error('transient');
            return Promise.resolve();
        });
        const logger = silentLogger();

        const result = await publish(VALID_EVENT, undefined, {
            queue,
            retryBackoffMs: zeroBackoff,
            logger,
        });

        expect(result).toEqual({ delivery: 'queue' });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            'queue send attempt failed',
            expect.objectContaining({ attempt: 1, budget: DEFAULT_MAX_QUEUE_RETRIES }),
        );
    });

    it('throws PublishError when every retry fails', async () => {
        const cause = new Error('bus unreachable');
        const { queue, spy } = fakeQueue(() => Promise.reject(cause));

        const err: unknown = await publish(VALID_EVENT, undefined, {
            queue,
            maxQueueRetries: 3,
            retryBackoffMs: zeroBackoff,
            logger: silentLogger(),
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(PublishError);
        const pe = err as PublishError;
        expect(pe.code).toBe('publish_failed');
        expect(pe.attempts).toBe(3);
        expect(pe.cause).toBe(cause);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(dbMocks.insertOutbox).not.toHaveBeenCalled();
    });

    it('throws PublishError when neither tx nor queue is provided', async () => {
        const err: unknown = await publish(VALID_EVENT, undefined, {
            logger: silentLogger(),
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(PublishError);
        expect((err as PublishError).code).toBe('publish_failed');
        expect(dbMocks.insertOutbox).not.toHaveBeenCalled();
    });

    it('applies the user-supplied backoff schedule between retries', async () => {
        const requestedDelays: number[] = [];
        const backoff: PublishDeps['retryBackoffMs'] = (attempt) => {
            // Record the attempt index the caller asked us about and
            // short-circuit to 0 so the test stays fast.
            requestedDelays.push(attempt);
            return 0;
        };
        const { queue, spy } = fakeQueue(() => Promise.reject(new Error('always fails')));

        await publish(VALID_EVENT, undefined, {
            queue,
            maxQueueRetries: 4,
            retryBackoffMs: backoff,
            logger: silentLogger(),
        }).catch(() => undefined);

        // 4 attempts ⇒ 3 backoff queries for attempts 1, 2, 3.
        expect(spy).toHaveBeenCalledTimes(4);
        expect(requestedDelays).toEqual([1, 2, 3]);
    });
});

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

describe('publish — envelope validation', () => {
    it('throws InvalidEventError when the event does not match the schema, without any I/O', async () => {
        // Cast through `unknown` so the test can hand an intentionally
        // malformed payload to the publisher (bogus `id`, empty payload).
        const malformed = {
            id: 'not-a-uuid',
            type: 'reservation.created',
            occurredAt: '2025-01-01T12:00:00.000Z',
            payload: {},
        } as unknown as AthlyaEvent;

        const { queue, spy } = fakeQueue(async () => Promise.resolve());

        await expect(
            publish(malformed, undefined, { queue, retryBackoffMs: zeroBackoff }),
        ).rejects.toBeInstanceOf(InvalidEventError);

        // Validation MUST run before any I/O so invalid events never
        // poison the outbox or the queue.
        expect(spy).not.toHaveBeenCalled();
        expect(dbMocks.insertOutbox).not.toHaveBeenCalled();
    });

    it('also rejects malformed events on the transactional path before touching the outbox', async () => {
        const malformed = { ...VALID_EVENT, type: 'not.a.real.event' } as unknown as AthlyaEvent;
        const { queue, spy } = fakeQueue(async () => Promise.resolve());

        await expect(
            publish(malformed, FAKE_TX, { queue, retryBackoffMs: zeroBackoff }),
        ).rejects.toBeInstanceOf(InvalidEventError);

        expect(dbMocks.insertOutbox).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
    });
});
