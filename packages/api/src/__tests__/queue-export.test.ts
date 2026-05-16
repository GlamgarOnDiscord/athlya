/**
 * Integration test — Worker `queue()` dispatcher routes
 * `members.export.requested` to {@link runExportJob} (Slice 1.3 —
 * Sprint 1 — SP1.4, audit finding S5-001).
 *
 * Scope
 * -----
 * The dispatcher's contract: when a non-DLQ batch carries a
 * `members.export.requested` envelope, the export consumer is
 * invoked with the deps bundle assembled by `buildExportDeps` and
 * the `exportJobId` extracted from the envelope payload. The
 * Cloudflare message is acked on every terminal kind returned by
 * the consumer (`completed` / `already_completed` / `failed` /
 * `not_found`) and retried only when the consumer throws.
 *
 * Strategy
 * --------
 *   • Mocks mirror the cascade test: `@athlya/members` provides the
 *     two consumer entry points; `cascade-deps` and `export-deps`
 *     are stubbed so the dispatcher's deps wiring is observable.
 *
 * Validation
 * ----------
 *   • Happy path — `members.export.requested` event → consumer
 *     called with the parsed `exportJobId` + deps sentinel → ack.
 *   • Mode dégradé R2 — when the env binding `EXPORTS_BUCKET` is
 *     undefined, the consumer returns `{ kind: 'failed', reason:
 *     'exports_bucket_missing' }` (the deps factory builds a
 *     stub BlobStore that throws inside the consumer's try/catch).
 *     The dispatcher must STILL ack: a `failed` job is a terminal
 *     state surfaced to the user, not a redelivery candidate.
 *   • Retry path — consumer throws (e.g. infrastructure failure
 *     before `markFailed`), dispatcher calls `msg.retry()`.
 *
 * Validates: Findings S5-001 (RGPD Article 15/20 export dispatch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const memberMocks = vi.hoisted(() => ({
    handleUserDeleted: vi.fn(),
    runExportJob: vi.fn(),
}));

vi.mock('@athlya/members', () => ({
    handleUserDeleted: memberMocks.handleUserDeleted,
    runExportJob: memberMocks.runExportJob,
}));

const adapterMocks = vi.hoisted(() => ({
    buildCascadeDeps: vi.fn(),
    buildExportDeps: vi.fn(),
}));

vi.mock('../adapters/cascade-deps.js', () => ({
    buildCascadeDeps: adapterMocks.buildCascadeDeps,
}));

vi.mock('../adapters/export-deps.js', () => ({
    buildExportDeps: adapterMocks.buildExportDeps,
}));

/* ------------------------------------------------------------------ */
/*  System under test                                                  */
/* ------------------------------------------------------------------ */

import { handleEventsBatch } from '../worker.js';

import type { AthlyaBindings } from '../types.js';
import type {
    Message,
    MessageBatch,
} from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
    const base: AthlyaBindings = {
        ENVIRONMENT: 'dev',
        EVENTS_QUEUE: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_QUEUE'],
        EVENTS_DLQ: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_DLQ'],
        DB_URL: 'postgres://export-test.invalid/athlya',
        REDIS_URL: 'https://export-test.upstash.io',
        REDIS_TOKEN: 'export-test-token',
        JWT_JWKS_URL: 'https://export-test.invalid/jwks.json',
        VERSION: 'export-test',
    };
    return { ...base, ...overrides };
}

function mockMessage<B>(id: string, body: B): Message<B> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
} {
    return {
        id,
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
    };
}

function mockBatch(
    queue: string,
    msgs: readonly (Message<unknown> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> })[],
): MessageBatch<unknown> {
    return {
        messages: msgs,
        queue,
        metadata: { metrics: null },
        retryAll: vi.fn(),
        ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
}

function exportRequestedEvent(
    userId: string,
    exportJobId: string,
    eventId = 'evt-export-1',
) {
    return {
        id: eventId,
        type: 'members.export.requested' as const,
        occurredAt: '2026-05-15T11:00:00.000Z',
        payload: { userId, exportJobId },
    };
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });

    adapterMocks.buildCascadeDeps.mockReturnValue({ __brand: 'cascade-deps-sentinel' });
    adapterMocks.buildExportDeps.mockReturnValue({ __brand: 'export-deps-sentinel' });
    memberMocks.handleUserDeleted.mockResolvedValue({ kind: 'ok', counts: { reservations: 0, sessions: 0, pushTokens: 0, auditAnonymized: 0 }, scheduledAnonymizationAt: '2026-06-14T10:00:00.000Z' });
    memberMocks.runExportJob.mockResolvedValue({ kind: 'completed', downloadUrl: 'https://r2.invalid/x.zip', expiresAt: '2026-05-18T10:00:00.000Z', sizeBytes: 0 });
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('worker.queue() — members.export.requested dispatch (Slice 1.3 SP1.4)', () => {
    it('forwards the exportJobId and deps to runExportJob then acks', async () => {
        const env = mockEnv();
        const jobId = '11111111-1111-4111-a111-111111111111';
        const event = exportRequestedEvent(
            '22222222-2222-4222-a222-222222222222',
            jobId,
        );
        const msg = mockMessage('msg-export-1', event);

        await handleEventsBatch(mockBatch('athlya-events', [msg]), env);

        expect(adapterMocks.buildExportDeps).toHaveBeenCalledTimes(1);
        expect(adapterMocks.buildExportDeps).toHaveBeenCalledWith(env);

        expect(memberMocks.runExportJob).toHaveBeenCalledTimes(1);
        const [forwardedJobId, forwardedDeps] = memberMocks.runExportJob.mock.calls[0]!;
        expect(forwardedJobId).toBe(jobId);
        expect(forwardedDeps).toEqual({ __brand: 'export-deps-sentinel' });

        expect(msg.ack).toHaveBeenCalledTimes(1);
        expect(msg.retry).not.toHaveBeenCalled();
        // Cascade branch must NOT fire on an export event.
        expect(memberMocks.handleUserDeleted).not.toHaveBeenCalled();
    });

    it('mode dégradé R2 — acks when consumer returns failed{exports_bucket_missing}', async () => {
        // Simulate the deps-factory degraded mode: consumer detects
        // the missing bucket inside its own try/catch and stamps
        // the export_jobs row as `failed`. Per the dispatcher's
        // contract, `failed` is a terminal state that must NOT be
        // retried.
        memberMocks.runExportJob.mockResolvedValueOnce({
            kind: 'failed',
            reason: 'exports_bucket_missing',
        });

        const env = mockEnv();
        expect((env as { EXPORTS_BUCKET?: unknown }).EXPORTS_BUCKET).toBeUndefined();

        const msg = mockMessage(
            'msg-export-degraded',
            exportRequestedEvent(
                '22222222-2222-4222-a222-222222222222',
                '33333333-3333-4333-a333-333333333333',
            ),
        );

        await handleEventsBatch(mockBatch('athlya-events', [msg]), env);

        expect(memberMocks.runExportJob).toHaveBeenCalledTimes(1);
        expect(msg.ack).toHaveBeenCalledTimes(1);
        expect(msg.retry).not.toHaveBeenCalled();
    });

    it('retries the message when the export consumer throws', async () => {
        memberMocks.runExportJob.mockRejectedValueOnce(
            new Error('transient infra failure'),
        );

        const msg = mockMessage(
            'msg-export-fail',
            exportRequestedEvent(
                '22222222-2222-4222-a222-222222222222',
                '44444444-4444-4444-a444-444444444444',
            ),
        );

        await handleEventsBatch(mockBatch('athlya-events', [msg]), mockEnv());

        expect(memberMocks.runExportJob).toHaveBeenCalledTimes(1);
        expect(msg.retry).toHaveBeenCalledTimes(1);
        expect(msg.ack).not.toHaveBeenCalled();
    });
});
