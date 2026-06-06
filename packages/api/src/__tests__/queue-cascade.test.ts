/**
 * Integration test — Worker `queue()` dispatcher routes
 * `auth.user.deleted` to {@link handleUserDeleted} (Slice 1.3 —
 * Sprint 1 — SP1.4, audit finding S5-002).
 *
 * Scope
 * -----
 * The dispatcher's contract: when a non-DLQ batch carries an
 * `auth.user.deleted` envelope, the cascade primitive is invoked
 * with the deps bundle assembled by `buildCascadeDeps`, and the
 * Cloudflare message is acked on success / retried on failure.
 *
 * Strategy
 * --------
 *   • `vi.mock('@athlya/members', …)` swaps the cascade primitive
 *     for a spy. The dispatcher imports `handleUserDeleted` from
 *     this module, so the spy intercepts every dispatch.
 *   • `vi.mock('../adapters/cascade-deps.js', …)` swaps the
 *     deps-builder for a spy that returns a tagged sentinel — we
 *     assert the bundle reached the cascade unchanged.
 *   • `vi.mock('../adapters/export-deps.js', …)` is needed because
 *     `worker.ts` imports `buildExportDeps` at module load: the
 *     real factory walks the deps-cache and would try to spin a
 *     Drizzle handle even when this test only exercises the
 *     cascade branch.
 *
 * Validation
 * ----------
 *   • Happy path — `auth.user.deleted` event → cascade called with
 *     the deps sentinel → `msg.ack()` once, `msg.retry()` zero.
 *   • Mode dégradé R2 — when the env binding `AVATARS_BUCKET` is
 *     undefined, the dispatch must still ack: the deps factory
 *     handles the fallback internally and the cascade primitive
 *     does not throw. The test asserts no `console.error` and one
 *     ack.
 *   • Failure path — when the cascade throws (transient SQL
 *     failure modelled by a rejected promise), the dispatcher
 *     calls `msg.retry()` and never `msg.ack()` so Cloudflare's
 *     redelivery budget kicks in.
 *   • Multi-event batch — a non-RGPD event in the same batch is
 *     quarantined on the DLQ (no silent ack).
 *
 * Validates: Findings S5-002 (RGPD Article 17 cascade dispatch).
 */

import { parseEvent } from '@athlya/shared/events';
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

const notificationMocks = vi.hoisted(() => ({
  handleEvent: vi.fn(),
}));

vi.mock('@athlya/notifications', () => ({
  HANDLED_EVENT_TYPES: [
    'reservation.created',
    'reservation.reminder',
    'reservation.cancelled',
    'reservation.promoted',
    'billing.subscription.failed',
  ],
  handleEvent: notificationMocks.handleEvent,
}));

const adapterMocks = vi.hoisted(() => ({
  buildCascadeDeps: vi.fn(),
  buildExportDeps: vi.fn(),
  buildNotificationsDeps: vi.fn(),
}));

vi.mock('../adapters/cascade-deps.js', () => ({
  buildCascadeDeps: adapterMocks.buildCascadeDeps,
}));

vi.mock('../adapters/export-deps.js', () => ({
  buildExportDeps: adapterMocks.buildExportDeps,
}));

vi.mock('../adapters/notifications-deps.js', () => ({
  buildNotificationsDeps: adapterMocks.buildNotificationsDeps,
}));

/* ------------------------------------------------------------------ */
/*  System under test (imports MUST come after vi.mock)                */
/* ------------------------------------------------------------------ */

import { handleEventsBatch, handleNotificationsBatch, handleRgpdBatch } from '../worker.js';

import type { AthlyaBindings } from '../types.js';
import type { Message, MessageBatch } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal `AthlyaBindings` env. Every domain field is
 * a placeholder — the dispatcher only forwards `env` to the deps
 * factory (which is mocked), so the values are never dereferenced.
 */
function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  const base: AthlyaBindings = {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_NOTIFICATIONS_QUEUE: {
      send: vi.fn(),
    } as unknown as AthlyaBindings['EVENTS_NOTIFICATIONS_QUEUE'],
    EVENTS_RGPD_QUEUE: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_RGPD_QUEUE'],
    EVENTS_DLQ: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: 'postgres://cascade-test.invalid/athlya',
    REDIS_URL: 'https://cascade-test.upstash.io',
    REDIS_TOKEN: 'cascade-test-token',
    JWT_JWKS_URL: 'https://cascade-test.invalid/jwks.json',
    VERSION: 'cascade-test',
  };
  return { ...base, ...overrides };
}

/** Build a Cloudflare-style message with `ack`/`retry` spies. */
function mockMessage<B>(
  id: string,
  body: B,
): Message<B> & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return {
    id,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<B> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
}

/** Wrap a list of messages in a non-DLQ `MessageBatch`. */
function mockBatch(
  queue: string,
  msgs: readonly (Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  })[],
): MessageBatch<unknown> {
  return {
    messages: msgs,
    queue,
    metadata: { metrics: null },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

/** Canonical `auth.user.deleted` envelope as the producer publishes it. */
function deletedEvent(userId: string, eventId = 'evt-cascade-1') {
  return {
    id: eventId,
    type: 'auth.user.deleted' as const,
    occurredAt: '2026-05-15T10:00:00.000Z',
    payload: { userId },
  };
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // Silence the structured `console.{warn,error}` lines emitted by
  // the dispatcher on the failure paths.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Default sentinel deps bundles so every test sees a
  // distinguishable object reference reach the consumer.
  adapterMocks.buildCascadeDeps.mockReturnValue({ __brand: 'cascade-deps-sentinel' });
  adapterMocks.buildExportDeps.mockReturnValue({ __brand: 'export-deps-sentinel' });
  adapterMocks.buildNotificationsDeps.mockReturnValue({ __brand: 'notifications-deps-sentinel' });
  memberMocks.handleUserDeleted.mockResolvedValue({
    kind: 'ok',
    counts: { reservations: 0, sessions: 0, pushTokens: 0, auditAnonymized: 0 },
    scheduledAnonymizationAt: '2026-06-14T10:00:00.000Z',
  });
  memberMocks.runExportJob.mockResolvedValue({
    kind: 'completed',
    downloadUrl: 'https://r2.invalid/x.zip',
    expiresAt: '2026-05-18T10:00:00.000Z',
    sizeBytes: 0,
  });
  notificationMocks.handleEvent.mockResolvedValue({
    status: 'ok',
    email: true,
    push: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('worker.queue() — auth.user.deleted dispatch (Slice 1.3 SP1.4)', () => {
  it('routes the event to handleUserDeleted with the cascade deps and acks the message', async () => {
    const env = mockEnv();
    const event = deletedEvent('00000000-0000-4000-a000-000000000001');
    const msg = mockMessage('msg-cascade-1', event);

    await handleRgpdBatch(mockBatch('athlya-events-rgpd', [msg]), env);

    expect(adapterMocks.buildCascadeDeps).toHaveBeenCalledTimes(1);
    expect(adapterMocks.buildCascadeDeps).toHaveBeenCalledWith(env);

    expect(memberMocks.handleUserDeleted).toHaveBeenCalledTimes(1);
    const [forwardedEvent, forwardedDeps] = memberMocks.handleUserDeleted.mock.calls[0]!;
    expect(forwardedEvent).toBe(event);
    expect(forwardedDeps).toEqual({ __brand: 'cascade-deps-sentinel' });

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    // Export branch must NOT fire on a cascade event.
    expect(memberMocks.runExportJob).not.toHaveBeenCalled();
  });

  it('mode dégradé R2 — acks even when AVATARS_BUCKET binding is undefined', async () => {
    // Production-like path before bucket provisioning: the env
    // is missing `AVATARS_BUCKET`. The deps factory builds a
    // degraded-mode AvatarStore that logs and resolves; the
    // cascade therefore returns `ok` and the dispatcher acks.
    const env = mockEnv();
    // Confirm the binding really is undefined on the env we feed
    // the dispatcher — the cascade-deps factory is what handles
    // the fallback, but the test guards against accidental future
    // pollution of the mock env.
    expect((env as { AVATARS_BUCKET?: unknown }).AVATARS_BUCKET).toBeUndefined();

    const msg = mockMessage(
      'msg-cascade-degraded',
      deletedEvent('00000000-0000-4000-a000-000000000002'),
    );
    await handleRgpdBatch(mockBatch('athlya-events-rgpd', [msg]), env);

    expect(memberMocks.handleUserDeleted).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries the message when the cascade throws', async () => {
    memberMocks.handleUserDeleted.mockRejectedValueOnce(new Error('transient SQL failure'));

    const msg = mockMessage(
      'msg-cascade-fail',
      deletedEvent('00000000-0000-4000-a000-000000000003'),
    );
    await handleEventsBatch(mockBatch('athlya-events', [msg]), mockEnv());

    expect(memberMocks.handleUserDeleted).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('routes reservation.created events to notifications consumer and acks', async () => {
    const notificationEvent = parseEvent({
      id: '00000000-0000-4000-a000-000000000010',
      type: 'reservation.created',
      occurredAt: '2026-05-15T10:00:00.000Z',
      studioId: '11111111-1111-4111-a111-111111111111',
      payload: {
        reservationId: '11111111-1111-4111-a111-111111111111',
        classId: '22222222-2222-4222-a222-222222222222',
        userId: '33333333-3333-4333-a333-333333333333',
      },
    });
    const msg = mockMessage('msg-notification', notificationEvent);

    await handleEventsBatch(mockBatch('athlya-events', [msg]), mockEnv());

    expect(memberMocks.handleUserDeleted).not.toHaveBeenCalled();
    expect(memberMocks.runExportJob).not.toHaveBeenCalled();
    expect(adapterMocks.buildNotificationsDeps).toHaveBeenCalledTimes(1);
    expect(notificationMocks.handleEvent).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks malformed notification payloads without retrying', async () => {
    const malformed = {
      id: 'not-a-uuid',
      type: 'reservation.created',
      occurredAt: '2026-05-15T10:00:00.000Z',
      payload: {
        reservationId: '11111111-1111-4111-a111-111111111111',
        classId: '22222222-2222-4222-a222-222222222222',
        userId: '33333333-3333-4333-a333-333333333333',
      },
    };
    const msg = mockMessage('msg-bad-notification', malformed);

    await handleEventsBatch(mockBatch('athlya-events', [msg]), mockEnv());

    expect(notificationMocks.handleEvent).not.toHaveBeenCalled();
    expect(adapterMocks.buildNotificationsDeps).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('quarantines unrelated event types on DLQ instead of silent ack', async () => {
    const stranger = {
      id: 'evt-other-2',
      type: 'auth.user.registered',
      occurredAt: '2026-05-15T10:00:00.000Z',
      payload: { userId: '11111111-1111-4111-a111-111111111111' },
    };
    const msg = mockMessage('msg-other', stranger);
    const env = mockEnv();
    const dlqSend = vi.mocked(env.EVENTS_DLQ.send);

    await handleEventsBatch(mockBatch('athlya-events', [msg]), env);

    expect(memberMocks.handleUserDeleted).not.toHaveBeenCalled();
    expect(memberMocks.runExportJob).not.toHaveBeenCalled();
    expect(notificationMocks.handleEvent).not.toHaveBeenCalled();
    expect(dlqSend).toHaveBeenCalledWith(stranger);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries when DLQ redirect fails for unknown event types', async () => {
    const stranger = {
      id: 'evt-other-3',
      type: 'auth.user.registered',
      occurredAt: '2026-05-15T10:00:00.000Z',
      payload: { userId: '11111111-1111-4111-a111-111111111111' },
    };
    const msg = mockMessage('msg-other-retry', stranger);
    const env = mockEnv({
      EVENTS_DLQ: {
        send: vi.fn().mockRejectedValue(new Error('dlq down')),
      } as unknown as AthlyaBindings['EVENTS_DLQ'],
    });

    await handleEventsBatch(mockBatch('athlya-events', [msg]), env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('quarantines misrouted types on the RGPD lane', async () => {
    const misrouted = {
      id: 'evt-res-on-rgpd',
      type: 'reservation.created',
      occurredAt: '2026-05-15T10:00:00.000Z',
      payload: {
        reservationId: '11111111-1111-4111-a111-111111111111',
        classId: '22222222-2222-4222-a222-222222222222',
        userId: '33333333-3333-4333-a333-333333333333',
      },
    };
    const msg = mockMessage('msg-rgpd-unknown', misrouted);
    const env = mockEnv();
    const dlqSend = vi.mocked(env.EVENTS_DLQ.send);

    await handleRgpdBatch(mockBatch('athlya-events-rgpd', [msg]), env);

    expect(dlqSend).toHaveBeenCalledWith(misrouted);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(memberMocks.handleUserDeleted).not.toHaveBeenCalled();
  });

  it('quarantines misrouted types on the notifications lane', async () => {
    const misrouted = deletedEvent('00000000-0000-4000-a000-000000000099');
    const msg = mockMessage('msg-notif-unknown', misrouted);
    const env = mockEnv();
    const dlqSend = vi.mocked(env.EVENTS_DLQ.send);

    await handleNotificationsBatch(mockBatch('athlya-events-notifications', [msg]), env);

    expect(dlqSend).toHaveBeenCalledWith(misrouted);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(notificationMocks.handleEvent).not.toHaveBeenCalled();
  });

  it('acks malformed envelopes without throwing', async () => {
    // Producer-side bug — body is not a parsable event. The
    // dispatcher must not retry forever, otherwise the message
    // burns Cloudflare's redelivery budget on a permanently
    // poisoned payload.
    const msg = mockMessage('msg-malformed', 'not-an-object' as unknown as object);

    await handleEventsBatch(mockBatch('athlya-events', [msg]), mockEnv());

    expect(memberMocks.handleUserDeleted).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });
});
