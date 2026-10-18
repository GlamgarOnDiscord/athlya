/**
 * Delivery of `auth.password_reset.requested` from the outbox (issue #645).
 *
 * The drain publishes the event on the notifications lane; the Worker
 * queue dispatcher hands it to `handlePasswordResetRequested`, which
 * mints the token and sends the email. These tests drive the real
 * dispatcher with a synthetic batch and assert the queue contract:
 *
 *   • success → one email, message acked;
 *   • transport failure → message retried (the queue dead-letters it
 *     after `max_retries`), dedup claim released so the retry sends;
 *   • redelivery after a success → no second email;
 *   • account gone by delivery time → acked without an email;
 *   • malformed envelope (e.g. carrying the address) → acked, nothing sent;
 *   • no log line carries the link, the token or the address.
 */

import { parseEvent } from '@athlya/shared/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  delivery: null as DeliverResetDeps | null,
  dedup: null as DedupStore | null,
}));

vi.mock('../adapters/auth-deps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/auth-deps.js')>()),
  buildPasswordResetDeliveryDeps: () => {
    if (hoisted.delivery === null) throw new Error('WEB_APP_URL is not configured in staging');
    return hoisted.delivery;
  },
}));

vi.mock('../adapters/notifications-deps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/notifications-deps.js')>()),
  buildDedupStore: () => hoisted.dedup,
}));

import { handlePasswordResetRequested } from '../events/password-reset-consumer.js';
import { handleEventsBatch, handleNotificationsBatch } from '../worker.js';

import type { AthlyaBindings } from '../types.js';
import type { DeliverResetDeps, UserRow } from '@athlya/auth';
import type { DedupStore } from '@athlya/notifications';
import type { AuthPasswordResetRequestedEvent } from '@athlya/shared/events';
import type { Message, MessageBatch } from '@cloudflare/workers-types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'member@athlya.test';

function resetEvent(id = '0193f000-0000-7000-8000-000000000645'): AuthPasswordResetRequestedEvent {
  const event = parseEvent({
    id,
    type: 'auth.password_reset.requested',
    occurredAt: '2026-10-18T10:00:00.000Z',
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: { userId: USER_ID },
  });
  if (event.type !== 'auth.password_reset.requested') throw new Error(event.type);
  return event;
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: EMAIL,
    displayName: 'Member',
    role: 'member',
    deletedAt: null,
    ...overrides,
  } as unknown as UserRow;
}

function memoryDedup(): DedupStore & { release: ReturnType<typeof vi.fn> } {
  const seen = new Set<string>();
  return {
    tryAcquire: vi.fn((eventId: string) => {
      if (seen.has(eventId)) return Promise.resolve(false);
      seen.add(eventId);
      return Promise.resolve(true);
    }),
    release: vi.fn((eventId: string) => {
      seen.delete(eventId);
      return Promise.resolve();
    }),
  };
}

function deliveryDeps(found: UserRow | null = user()) {
  return {
    userRepo: { findUserById: vi.fn().mockResolvedValue(found) },
    passwordResetRepo: {
      insertToken: vi.fn().mockResolvedValue(undefined),
      findActiveTokenByHash: vi.fn(),
      consumeAndResetPassword: vi.fn(),
    },
    emailTransport: { sendResetEmail: vi.fn().mockResolvedValue(undefined) },
    resetLinkBaseUrl: 'https://app.athlya.test',
  };
}

type SpyMessage = Message<unknown> & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

function message(body: unknown, id = 'msg-1'): SpyMessage {
  const spy: unknown = {
    id,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return spy as SpyMessage;
}

function batch(queue: string, messages: SpyMessage[]): MessageBatch<unknown> {
  return {
    queue,
    messages,
    metadata: { metrics: null },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

const env = {
  ENVIRONMENT: 'staging',
  EVENTS_DLQ: { send: vi.fn() },
} as unknown as AthlyaBindings;

let logs: ReturnType<typeof vi.spyOn>[] = [];
let deps: ReturnType<typeof deliveryDeps>;
let dedup: ReturnType<typeof memoryDedup>;

beforeEach(() => {
  logs = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  deps = deliveryDeps();
  dedup = memoryDedup();
  hoisted.delivery = deps;
  hoisted.dedup = dedup;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sentLink(): string {
  const call = deps.emailTransport.sendResetEmail.mock.calls[0] as [{ link: string }] | undefined;
  if (call === undefined) throw new Error('no email sent');
  return call[0].link;
}

function expectNoSecretInLogs(): void {
  const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
  expect(logged).not.toContain('reset-password');
  expect(logged).not.toContain(EMAIL);
  const calls = deps.emailTransport.sendResetEmail.mock.calls as [{ link: string }][];
  for (const [{ link }] of calls) {
    expect(logged).not.toContain(link.split('/').pop()!);
  }
}

describe('notifications lane — auth.password_reset.requested', () => {
  it('sends the email and acks', async () => {
    const msg = message(resetEvent());

    await handleNotificationsBatch(batch('athlya-events-notifications', [msg]), env);

    expect(deps.userRepo.findUserById).toHaveBeenCalledWith(USER_ID);
    expect(deps.passwordResetRepo.insertToken).toHaveBeenCalledOnce();
    expect(deps.emailTransport.sendResetEmail).toHaveBeenCalledOnce();
    expect(sentLink()).toMatch(/^https:\/\/app\.athlya\.test\/reset-password\/[A-Za-z0-9_-]+$/);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expectNoSecretInLogs();
  });

  it('retries on a transport failure, then sends on redelivery', async () => {
    deps.emailTransport.sendResetEmail.mockRejectedValueOnce(new Error('resend HTTP 503'));
    const first = message(resetEvent(), 'msg-attempt-1');

    await handleNotificationsBatch(batch('athlya-events-notifications', [first]), env);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(dedup.release).toHaveBeenCalledWith(resetEvent().id);

    const second = message(resetEvent(), 'msg-attempt-2');
    await handleNotificationsBatch(batch('athlya-events-notifications', [second]), env);

    expect(second.ack).toHaveBeenCalledOnce();
    expect(deps.emailTransport.sendResetEmail).toHaveBeenCalledTimes(2);
    expect(deps.passwordResetRepo.insertToken).toHaveBeenCalledTimes(2);
    expectNoSecretInLogs();
  });

  it('does not send a second email when a delivered event is redelivered', async () => {
    const first = message(resetEvent(), 'msg-1');
    const replay = message(resetEvent(), 'msg-2');

    await handleNotificationsBatch(batch('athlya-events-notifications', [first, replay]), env);

    expect(deps.emailTransport.sendResetEmail).toHaveBeenCalledOnce();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
  });

  it('acks without an email when the account was deleted before delivery', async () => {
    deps = deliveryDeps(user({ deletedAt: new Date('2026-10-18T09:00:00Z') }));
    hoisted.delivery = deps;
    const msg = message(resetEvent());

    await handleNotificationsBatch(batch('athlya-events-notifications', [msg]), env);

    expect(deps.passwordResetRepo.insertToken).not.toHaveBeenCalled();
    expect(deps.emailTransport.sendResetEmail).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('retries when the delivery cannot be configured (e.g. missing WEB_APP_URL)', async () => {
    hoisted.delivery = null;
    const msg = message(resetEvent());

    await handleNotificationsBatch(batch('athlya-events-notifications', [msg]), env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks a malformed envelope without delivering it', async () => {
    const forged = { ...resetEvent(), payload: { userId: USER_ID, email: EMAIL } };
    const msg = message(forged);

    await handleNotificationsBatch(batch('athlya-events-notifications', [msg]), env);

    expect(deps.userRepo.findUserById).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expectNoSecretInLogs();
  });
});

describe('legacy events queue — auth.password_reset.requested', () => {
  it('delivers backlog published on the monolithic queue', async () => {
    const msg = message(resetEvent());

    await handleEventsBatch(batch('athlya-events', [msg]), env);

    expect(deps.emailTransport.sendResetEmail).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});

describe('handlePasswordResetRequested', () => {
  it('rethrows the delivery failure even when releasing the claim fails', async () => {
    deps.emailTransport.sendResetEmail.mockRejectedValueOnce(new Error('resend down'));
    dedup.release.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      handlePasswordResetRequested(resetEvent(), { dedup, delivery: deps }),
    ).rejects.toThrow('resend down');
  });
});
