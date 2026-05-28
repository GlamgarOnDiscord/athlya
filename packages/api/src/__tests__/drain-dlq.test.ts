/**
 * Unit tests for the DLQ drain + admin helpers (hardening task H2).
 *
 * Scope — the pure module under test (`events/drain-dlq.ts`) exposes
 * four operations:
 *
 *   1. `handleDlqBatch`  — consumer for `athlya-events-dlq`. Upserts
 *      a Redis tracker entry + sorted set member per observed
 *      message, acks the queue message.
 *   2. `dlqStats`        — snapshot the tracker.
 *   3. `dlqReplay`       — re-publish a tracked payload and remove
 *      the tracker entry.
 *   4. `dlqDiscard`      — remove a tracker entry without replay.
 *
 * The suite uses a dedicated in-memory `FakeDlqRedis` (separate from
 * `tests/helpers/fake-redis.ts` which only supports the rate limiter
 * subset) because the DLQ tracker uses `set`/`get`/`del` keys plus
 * `zadd`/`zrange`/`zrem`/`zcard` — a different command surface.
 *
 * Cloudflare message mocks are plain objects with an `ack` vi.fn()
 * spy so the tests can verify the "ack after track" invariant.
 *
 * Validates: hardening plan H2 (DLQ drain + observability).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDlqRedisCache,
  __resetDlqSentryCacheForTests,
  __setDlqRedisForTests,
  dlqDiscard,
  dlqReplay,
  dlqStats,
  handleDlqBatch,
} from '../events/drain-dlq.js';

import type { DlqBindings } from '../events/drain-dlq.js';
import type { Message, MessageBatch, Queue } from '@cloudflare/workers-types';
import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Fake Redis                                                         */
/* ------------------------------------------------------------------ */

/**
 * In-memory fake covering every Redis command the DLQ module issues.
 *
 *   - `get(key)`                 returns a stored string or null.
 *   - `set(key, value)`          stores a string.
 *   - `del(key)`                 removes a key.
 *   - `zadd(key, {score,member})` adds or replaces a sorted-set entry.
 *   - `zrange(key, start, stop)` returns members by index, ascending
 *     score order.
 *   - `zrem(key, member)`        removes a member.
 *   - `zcard(key)`               returns the member count.
 *
 * Kept local to this test file rather than extending
 * `tests/helpers/fake-redis.ts` because the shared helper supports
 * only the rate-limiter subset (pipeline-centric) and mixing the two
 * surfaces would bloat it for every future consumer.
 */
class FakeDlqRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, { score: number; member: string }[]>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const v = this.strings.get(key);
    return v === undefined ? null : (v as unknown as T);
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async zadd(key: string, entry: { score: number; member: string }): Promise<number> {
    let list = this.sets.get(key);
    if (!list) {
      list = [];
      this.sets.set(key, list);
    }
    const existing = list.findIndex((e) => e.member === entry.member);
    if (existing >= 0) {
      list[existing] = entry;
      return 0;
    }
    list.push(entry);
    list.sort((a, b) => a.score - b.score);
    return 1;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = [...(this.sets.get(key) ?? [])].sort((a, b) => a.score - b.score);
    const end = stop === -1 ? list.length - 1 : stop;
    return list.slice(start, end + 1).map((e) => e.member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const list = this.sets.get(key);
    if (!list) return 0;
    const idx = list.findIndex((e) => e.member === member);
    if (idx < 0) return 0;
    list.splice(idx, 1);
    return 1;
  }

  async zcard(key: string): Promise<number> {
    return this.sets.get(key)?.length ?? 0;
  }
}

/** Cast the fake into the Upstash `Redis` shape for the module seam. */
function asRedis(fake: FakeDlqRedis): Redis {
  return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEST_REDIS_URL = 'https://dlq-tests.upstash.io';

/** Build a mock `Queue<unknown>` whose `send` is a spy. */
function mockQueue(): Queue<unknown> & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn<(msg: unknown) => Promise<void>>().mockResolvedValue(undefined);
  return {
    send,
    sendBatch: vi.fn(),
  } as unknown as Queue<unknown> & { send: ReturnType<typeof vi.fn> };
}

/**
 * Build a full {@link DlqBindings} wired to the pre-seeded fake
 * Redis. The bindings' REDIS_URL matches the key we seeded so
 * `resolveRedis(env)` returns our fake without hitting Upstash.
 */
function mockBindings(): {
  env: DlqBindings;
  eventsQueue: ReturnType<typeof mockQueue>;
  notificationsQueue: ReturnType<typeof mockQueue>;
  rgpdQueue: ReturnType<typeof mockQueue>;
  eventsDlq: ReturnType<typeof mockQueue>;
  redis: FakeDlqRedis;
} {
  const redis = new FakeDlqRedis();
  __setDlqRedisForTests(TEST_REDIS_URL, asRedis(redis));
  const eventsQueue = mockQueue();
  const notificationsQueue = mockQueue();
  const rgpdQueue = mockQueue();
  const eventsDlq = mockQueue();
  const env: DlqBindings = {
    EVENTS_QUEUE: eventsQueue,
    EVENTS_NOTIFICATIONS_QUEUE: notificationsQueue,
    EVENTS_RGPD_QUEUE: rgpdQueue,
    EVENTS_DLQ: eventsDlq,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_TOKEN: 'test-token',
  };
  return { env, eventsQueue, notificationsQueue, rgpdQueue, eventsDlq, redis };
}

/**
 * Build a single Cloudflare DLQ message double. `ack` / `retry` are
 * spies so the suite can assert the "ack after track" invariant
 * without scraping log output.
 */
function mockMessage<B>(id: string, body: B): Message<B> & { ack: ReturnType<typeof vi.fn> } {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return {
    id,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<B> & { ack: ReturnType<typeof vi.fn> };
}

/** Build a DLQ batch envelope around `msgs`. */
function mockBatch(
  msgs: readonly (Message<unknown> & { ack: ReturnType<typeof vi.fn> })[],
): MessageBatch<unknown> {
  return {
    messages: msgs,
    queue: 'athlya-events-dlq',
    metadata: { metrics: null },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  __resetDlqRedisCache();
  __resetDlqSentryCacheForTests();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDlqRedisCache();
  __resetDlqSentryCacheForTests();
});

/* ------------------------------------------------------------------ */
/*  handleDlqBatch                                                     */
/* ------------------------------------------------------------------ */

describe('handleDlqBatch', () => {
  it('tracks every observed message and acks it', async () => {
    const { env, redis } = mockBindings();
    const m1 = mockMessage('msg-1', { type: 'reservation.created', id: 'evt-1' });
    const m2 = mockMessage('msg-2', { type: 'reservation.cancelled', id: 'evt-2' });
    const m3 = mockMessage('msg-3', { type: 'billing.invoice.paid', id: 'evt-3' });

    const result = await handleDlqBatch(mockBatch([m1, m2, m3]), env);

    expect(result).toEqual({ observed: 3, tracked: 3, totalPending: 3 });

    // Each message was acked — Cloudflare will not redeliver.
    expect(m1.ack).toHaveBeenCalledTimes(1);
    expect(m2.ack).toHaveBeenCalledTimes(1);
    expect(m3.ack).toHaveBeenCalledTimes(1);

    // One tracker entry per message.
    expect(redis.strings.has('dlq:entry:msg-1')).toBe(true);
    expect(redis.strings.has('dlq:entry:msg-2')).toBe(true);
    expect(redis.strings.has('dlq:entry:msg-3')).toBe(true);
    expect(redis.sets.get('dlq:pending')?.length).toBe(3);
  });

  it('bumps attempts on re-observation of the same id without duplicating', async () => {
    const { env, redis } = mockBindings();
    const first = mockMessage('dup-id', { payload: 'v1' });
    const second = mockMessage('dup-id', { payload: 'v2' });

    const r1 = await handleDlqBatch(mockBatch([first]), env);
    const r2 = await handleDlqBatch(mockBatch([second]), env);

    expect(r1).toEqual({ observed: 1, tracked: 1, totalPending: 1 });
    // `tracked` counts new entries only — the re-observation is
    // `observed` but not `tracked`, and the sorted set size is
    // unchanged.
    expect(r2).toEqual({ observed: 1, tracked: 0, totalPending: 1 });

    const raw = redis.strings.get('dlq:entry:dup-id');
    expect(raw).toBeDefined();
    const entry = JSON.parse(raw ?? '{}') as {
      attempts: number;
      payload: { payload: string };
    };
    expect(entry.attempts).toBe(2);
    // Original payload is preserved (first copy wins).
    expect(entry.payload).toEqual({ payload: 'v1' });
  });

  it('stores firstSeenAt and lastSeenAt as epoch milliseconds', async () => {
    const { env, redis } = mockBindings();
    const before = Date.now();
    const msg = mockMessage('time-id', { hello: 'world' });

    await handleDlqBatch(mockBatch([msg]), env);

    const after = Date.now();
    const raw = redis.strings.get('dlq:entry:time-id');
    expect(raw).toBeDefined();
    const entry = JSON.parse(raw ?? '{}') as {
      firstSeenAt: number;
      lastSeenAt: number;
    };
    expect(entry.firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(entry.firstSeenAt).toBeLessThanOrEqual(after);
    expect(entry.lastSeenAt).toBe(entry.firstSeenAt);
  });

  it('empty batch is a no-op', async () => {
    const { env, redis } = mockBindings();
    const result = await handleDlqBatch(mockBatch([]), env);
    expect(result).toEqual({ observed: 0, tracked: 0, totalPending: 0 });
    expect(redis.strings.size).toBe(0);
    expect(redis.sets.size).toBe(0);
  });

  it('keeps the original firstSeenAt when the same id is re-observed', async () => {
    const { env, redis } = mockBindings();
    const first = mockMessage('stable-id', { v: 1 });
    await handleDlqBatch(mockBatch([first]), env);

    const firstRaw = redis.strings.get('dlq:entry:stable-id');
    const firstEntry = JSON.parse(firstRaw ?? '{}') as {
      firstSeenAt: number;
    };

    // Tick forward so any accidental overwrite would be visible.
    await new Promise<void>((r) => setTimeout(r, 5));
    const second = mockMessage('stable-id', { v: 2 });
    await handleDlqBatch(mockBatch([second]), env);

    const secondRaw = redis.strings.get('dlq:entry:stable-id');
    const secondEntry = JSON.parse(secondRaw ?? '{}') as {
      firstSeenAt: number;
      lastSeenAt: number;
    };
    expect(secondEntry.firstSeenAt).toBe(firstEntry.firstSeenAt);
    expect(secondEntry.lastSeenAt).toBeGreaterThanOrEqual(firstEntry.firstSeenAt);
  });

  it('emits a fallback alert log on each freshly tracked entry when no Sentry DSN is configured (B6.2)', async () => {
    const { env } = mockBindings();
    // Re-arm the console.error spy — beforeEach silenced it,
    // we want to count alert lines and the no-Sentry fallback
    // line shape from `alertOnDlqEntry` in particular.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const m1 = mockMessage('alert-1', {
      id: 'evt-A',
      type: 'reservation.created',
    });
    const m2 = mockMessage('alert-2', {
      id: 'evt-B',
      type: 'billing.invoice.paid',
    });

    await handleDlqBatch(mockBatch([m1, m2]), env);

    // One alert line per freshly tracked entry. The fallback
    // path uses console.error with the canonical
    // "[dlq] alert (no Sentry DSN configured)" prefix.
    const alertCalls = errSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('alert (no Sentry DSN configured)'),
    );
    expect(alertCalls.length).toBe(2);

    // Re-observation of the same id does NOT re-alert: alerts
    // are tied to the `isNew` branch only.
    const m1Replay = mockMessage('alert-1', {
      id: 'evt-A',
      type: 'reservation.created',
    });
    await handleDlqBatch(mockBatch([m1Replay]), env);
    const alertCallsAfter = errSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('alert (no Sentry DSN configured)'),
    );
    expect(alertCallsAfter.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/*  dlqStats                                                           */
/* ------------------------------------------------------------------ */

describe('dlqStats', () => {
  it('returns zero pending and null oldestAgeMs on an empty tracker', async () => {
    const { env } = mockBindings();
    const snap = await dlqStats(env);
    expect(snap).toEqual({ pending: 0, oldestAgeMs: null, entries: [] });
  });

  it('returns entries ordered oldest-first with oldestAgeMs > 0', async () => {
    const { env, redis } = mockBindings();

    // Seed entries with explicit firstSeenAt values to make the
    // ordering deterministic without having to sleep.
    redis.strings.set(
      'dlq:entry:old',
      JSON.stringify({
        id: 'old',
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        attempts: 1,
        payload: { n: 1 },
        lastError: null,
      }),
    );
    redis.strings.set(
      'dlq:entry:mid',
      JSON.stringify({
        id: 'mid',
        firstSeenAt: 2_000,
        lastSeenAt: 2_000,
        attempts: 1,
        payload: { n: 2 },
        lastError: null,
      }),
    );
    redis.strings.set(
      'dlq:entry:new',
      JSON.stringify({
        id: 'new',
        firstSeenAt: 3_000,
        lastSeenAt: 3_000,
        attempts: 1,
        payload: { n: 3 },
        lastError: null,
      }),
    );
    redis.sets.set('dlq:pending', [
      { score: 3_000, member: 'new' },
      { score: 1_000, member: 'old' },
      { score: 2_000, member: 'mid' },
    ]);

    const snap = await dlqStats(env);
    expect(snap.pending).toBe(3);
    expect(snap.oldestAgeMs).not.toBeNull();
    expect(snap.oldestAgeMs ?? -1).toBeGreaterThan(0);
    expect(snap.entries.map((e) => e.id)).toEqual(['old', 'mid', 'new']);
  });

  it('caps entries at 100 even when more ids are pending', async () => {
    const { env, redis } = mockBindings();
    const members: { score: number; member: string }[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `cap-${String(i).padStart(4, '0')}`;
      redis.strings.set(
        `dlq:entry:${id}`,
        JSON.stringify({
          id,
          firstSeenAt: i,
          lastSeenAt: i,
          attempts: 1,
          payload: { i },
          lastError: null,
        }),
      );
      members.push({ score: i, member: id });
    }
    redis.sets.set('dlq:pending', members);

    const snap = await dlqStats(env);
    expect(snap.pending).toBe(150);
    expect(snap.entries.length).toBe(100);
    // Still oldest-first within the window.
    expect(snap.entries[0]?.id).toBe('cap-0000');
    expect(snap.entries[99]?.id).toBe('cap-0099');
  });

  it('skips orphan members whose entry blob is missing', async () => {
    const { env, redis } = mockBindings();
    redis.strings.set(
      'dlq:entry:present',
      JSON.stringify({
        id: 'present',
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        attempts: 1,
        payload: {},
        lastError: null,
      }),
    );
    redis.sets.set('dlq:pending', [
      { score: 500, member: 'ghost' },
      { score: 1_000, member: 'present' },
    ]);

    const snap = await dlqStats(env);
    // pending reflects the sorted set exactly — cheap ZCARD.
    expect(snap.pending).toBe(2);
    // entries filters the orphan.
    expect(snap.entries.map((e) => e.id)).toEqual(['present']);
  });
});

/* ------------------------------------------------------------------ */
/*  dlqReplay                                                          */
/* ------------------------------------------------------------------ */

describe('dlqReplay', () => {
  it('routes replay to the lane-specific queue from payload type', async () => {
    const { env, notificationsQueue, redis } = mockBindings();
    const payload = { id: 'evt-1', type: 'reservation.created' };
    redis.strings.set(
      'dlq:entry:ok-id',
      JSON.stringify({
        id: 'ok-id',
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        attempts: 3,
        payload,
        lastError: null,
      }),
    );
    redis.sets.set('dlq:pending', [{ score: 1_000, member: 'ok-id' }]);

    const result = await dlqReplay(env, 'ok-id');
    expect(result).toEqual({ replayed: true, messageType: 'reservation.created' });

    // Payload was re-published verbatim.
    expect(notificationsQueue.send).toHaveBeenCalledTimes(1);
    expect(notificationsQueue.send).toHaveBeenCalledWith(payload);

    // Tracker state was dropped.
    expect(redis.strings.has('dlq:entry:ok-id')).toBe(false);
    expect(redis.sets.get('dlq:pending')?.length).toBe(0);
  });

  it('returns replayed: false with reason not_found on an unknown id', async () => {
    const { env, eventsQueue } = mockBindings();
    const result = await dlqReplay(env, 'does-not-exist');
    expect(result).toEqual({ replayed: false, reason: 'not_found' });
    expect(eventsQueue.send).not.toHaveBeenCalled();
  });

  it('treats empty or falsy ids as not_found', async () => {
    const { env, eventsQueue } = mockBindings();
    expect(await dlqReplay(env, '')).toEqual({
      replayed: false,
      reason: 'not_found',
    });
    expect(eventsQueue.send).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  dlqDiscard                                                         */
/* ------------------------------------------------------------------ */

describe('dlqDiscard', () => {
  it('removes the tracker entry and returns discarded: true', async () => {
    const { env, redis } = mockBindings();
    redis.strings.set(
      'dlq:entry:drop-id',
      JSON.stringify({
        id: 'drop-id',
        firstSeenAt: 1,
        lastSeenAt: 1,
        attempts: 1,
        payload: {},
        lastError: null,
      }),
    );
    redis.sets.set('dlq:pending', [{ score: 1, member: 'drop-id' }]);

    const result = await dlqDiscard(env, 'drop-id');
    expect(result).toEqual({ discarded: true });
    expect(redis.strings.has('dlq:entry:drop-id')).toBe(false);
    expect(redis.sets.get('dlq:pending')?.length).toBe(0);
  });

  it('is idempotent on missing ids', async () => {
    const { env } = mockBindings();
    expect(await dlqDiscard(env, 'ghost')).toEqual({ discarded: true });
    // Second call on the same id is still a no-op success.
    expect(await dlqDiscard(env, 'ghost')).toEqual({ discarded: true });
  });
});
