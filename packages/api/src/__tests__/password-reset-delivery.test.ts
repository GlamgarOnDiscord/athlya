/**
 * Delivery of `auth.password_reset.requested` from the outbox (issues
 * #645, #650).
 *
 * The drain publishes the event on the notifications lane; the Worker
 * queue dispatcher hands it to `handlePasswordResetRequested`. These
 * tests drive the real dispatcher with a synthetic batch, the real
 * Redis delivery-state adapter on an in-memory Redis and the real
 * per-request token deriver, and assert the queue contract:
 *
 *   • success → one email, message acked, event marked completed;
 *   • transport failure → message retried (the queue dead-letters it
 *     after `max_retries`); the retry sends the SAME link with the same
 *     idempotency key, so an ambiguous first attempt cannot invalidate
 *     a delivered link;
 *   • in-flight duplicate → retried after the in-flight TTL, not acked;
 *   • stale in-flight mark (crashed isolate) → the next attempt sends;
 *   • redelivery after a success → acked without a second email;
 *   • account gone or token superseded → acked without an email;
 *   • malformed envelope (e.g. carrying the address) → acked;
 *   • no log line carries the link, the token or the address.
 */

import { createResetTokenDeriver } from '@athlya/auth';
import { parseEvent } from '@athlya/shared/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  delivery: null as DeliverResetDeps | null,
  redis: null as MemoryRedis | null,
}));

vi.mock('../adapters/auth-deps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/auth-deps.js')>()),
  buildPasswordResetDeliveryDeps: () => {
    if (hoisted.delivery === null) throw new Error('WEB_APP_URL is not configured in staging');
    return hoisted.delivery;
  },
}));

vi.mock('../adapters/deps-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/deps-cache.js')>()),
  getOrCreateRedis: () => hoisted.redis,
}));

import { createRedisPasswordResetDeliveryStore } from '../adapters/password-reset-delivery-store-redis.js';
import {
  PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS,
  handlePasswordResetRequested,
} from '../events/password-reset-consumer.js';
import { handleEventsBatch, handleNotificationsBatch } from '../worker.js';

import type { DeliveryStoreRedis } from '../adapters/password-reset-delivery-store-redis.js';
import type { AthlyaBindings } from '../types.js';
import type { DeliverResetDeps, RequestTokenIssue, UserRow } from '@athlya/auth';
import type { AuthPasswordResetRequestedEvent } from '@athlya/shared/events';
import type { Message, MessageBatch } from '@cloudflare/workers-types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'member@athlya.test';
const EVENT_ID = '0193f000-0000-7000-8000-000000000645';
const DELIVERY_KEY = `auth:password-reset:delivery:${EVENT_ID}`;

/** Minimal in-memory Redis with `SET NX EX`, `GET`, `DEL` (TTLs ignored). */
class MemoryRedis implements DeliveryStoreRedis {
  public readonly values = new Map<string, string>();
  public set(key: string, value: string, opts: { nx?: true; ex: number }): Promise<unknown> {
    if (opts.nx === true && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }
  public get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  public del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

function resetEvent(id = EVENT_ID): AuthPasswordResetRequestedEvent {
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
  const row: unknown = {
    id: USER_ID,
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: EMAIL,
    displayName: 'Member',
    role: 'member',
    deletedAt: null,
    ...overrides,
  };
  return row as UserRow;
}

function deliveryDeps(found: UserRow | null = user(), outcome: RequestTokenIssue = 'issued') {
  return {
    userRepo: { findUserById: vi.fn().mockResolvedValue(found) },
    tokens: { issueForRequest: vi.fn().mockResolvedValue(outcome) },
    emailTransport: { sendResetEmail: vi.fn().mockResolvedValue(undefined) },
    deriveToken: createResetTokenDeriver('k'.repeat(32)),
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
  const value: unknown = {
    queue,
    messages,
    metadata: { metrics: null },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return value as MessageBatch<unknown>;
}

const envValue: unknown = {
  ENVIRONMENT: 'staging',
  REDIS_URL: 'https://redis.invalid',
  REDIS_TOKEN: 'token',
  EVENTS_DLQ: { send: vi.fn() },
};
const env = envValue as AthlyaBindings;

let logs: ReturnType<typeof vi.spyOn>[] = [];
let deps: ReturnType<typeof deliveryDeps>;
let redis: MemoryRedis;

beforeEach(() => {
  logs = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  deps = deliveryDeps();
  redis = new MemoryRedis();
  hoisted.delivery = deps;
  hoisted.redis = redis;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sends(): { link: string; idempotencyKey?: string }[] {
  return (deps.emailTransport.sendResetEmail.mock.calls as [{ link: string }][]).map(
    ([input]) => input,
  );
}

function expectNoSecretInLogs(): void {
  const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
  expect(logged).not.toContain('reset-password');
  expect(logged).not.toContain(EMAIL);
  for (const { link } of sends()) {
    expect(logged).not.toContain(link.split('/').pop()!);
  }
}

const notifications = (msgs: SpyMessage[]) => batch('athlya-events-notifications', msgs);

describe('notifications lane — auth.password_reset.requested', () => {
  it('sends the email, acks and marks the event completed', async () => {
    const msg = message(resetEvent());

    await handleNotificationsBatch(notifications([msg]), env);

    expect(deps.userRepo.findUserById).toHaveBeenCalledWith(USER_ID);
    expect(deps.tokens.issueForRequest).toHaveBeenCalledOnce();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.link).toMatch(/^https:\/\/app\.athlya\.test\/reset-password\/[\w-]+$/u);
    expect(sends()[0]?.idempotencyKey).toBe(`password-reset/${EVENT_ID}`);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(redis.values.get(DELIVERY_KEY)).toBe('completed');
    expectNoSecretInLogs();
  });

  it('retries an ambiguous failure with the same link and idempotency key', async () => {
    deps.emailTransport.sendResetEmail.mockRejectedValueOnce(new Error('socket hang up'));
    const first = message(resetEvent(), 'msg-attempt-1');

    await handleNotificationsBatch(notifications([first]), env);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(redis.values.has(DELIVERY_KEY)).toBe(false);

    const second = message(resetEvent(), 'msg-attempt-2');
    await handleNotificationsBatch(notifications([second]), env);

    expect(second.ack).toHaveBeenCalledOnce();
    const [attempt1, attempt2] = sends();
    expect(attempt2?.link).toBe(attempt1?.link);
    expect(attempt2?.idempotencyKey).toBe(attempt1?.idempotencyKey);
    const hashes = (deps.tokens.issueForRequest.mock.calls as [{ tokenHash: string }][]).map(
      ([input]) => input.tokenHash,
    );
    expect(hashes[1]).toBe(hashes[0]);
    expectNoSecretInLogs();
  });

  it('retries an in-flight duplicate after the in-flight TTL instead of acking it', async () => {
    redis.values.set(DELIVERY_KEY, 'in_flight');
    const msg = message(resetEvent());

    await handleNotificationsBatch(notifications([msg]), env);

    expect(sends()).toHaveLength(0);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS });
  });

  it('sends once a crashed attempt’s in-flight mark has expired', async () => {
    redis.values.set(DELIVERY_KEY, 'in_flight');
    await handleNotificationsBatch(notifications([message(resetEvent(), 'msg-1')]), env);

    redis.values.delete(DELIVERY_KEY); // the in-flight TTL elapsed
    const retry = message(resetEvent(), 'msg-2');
    await handleNotificationsBatch(notifications([retry]), env);

    expect(sends()).toHaveLength(1);
    expect(retry.ack).toHaveBeenCalledOnce();
  });

  it('acks a redelivery of a completed event without a second email', async () => {
    const first = message(resetEvent(), 'msg-1');
    const replay = message(resetEvent(), 'msg-2');

    await handleNotificationsBatch(notifications([first, replay]), env);

    expect(sends()).toHaveLength(1);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
  });

  it.each([
    ['the account was deleted before delivery', user({ deletedAt: new Date() }), 'issued'],
    ['the token was superseded or used', user(), 'superseded'],
  ] as const)('acks without an email when %s', async (_label, found, outcome) => {
    deps = deliveryDeps(found, outcome);
    hoisted.delivery = deps;
    const msg = message(resetEvent());

    await handleNotificationsBatch(notifications([msg]), env);

    expect(sends()).toHaveLength(0);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('retries when the delivery cannot be configured (e.g. missing WEB_APP_URL)', async () => {
    hoisted.delivery = null;
    const msg = message(resetEvent());

    await handleNotificationsBatch(notifications([msg]), env);

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks a malformed envelope without delivering it', async () => {
    const forged = { ...resetEvent(), payload: { userId: USER_ID, email: EMAIL } };
    const msg = message(forged);

    await handleNotificationsBatch(notifications([msg]), env);

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

    expect(sends()).toHaveLength(1);
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});

describe('handlePasswordResetRequested', () => {
  it('rethrows the delivery failure even when clearing the in-flight mark fails', async () => {
    deps.emailTransport.sendResetEmail.mockRejectedValueOnce(new Error('resend down'));
    const deliveries = createRedisPasswordResetDeliveryStore(redis);
    vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('redis down'));

    await expect(
      handlePasswordResetRequested(resetEvent(), { deliveries, delivery: deps }),
    ).rejects.toThrow('resend down');
  });

  it('acks a sent email even when marking it completed fails', async () => {
    const deliveries = createRedisPasswordResetDeliveryStore(redis);
    vi.spyOn(deliveries, 'complete').mockRejectedValueOnce(new Error('redis down'));

    await expect(
      handlePasswordResetRequested(resetEvent(), { deliveries, delivery: deps }),
    ).resolves.toBe('sent');
  });
});
