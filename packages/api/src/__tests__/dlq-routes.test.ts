/**
 * Integration-style tests for the DLQ admin router (hardening task H2).
 *
 * Scope:
 *   • `GET  /admin/dlq/stats`            — admin-only snapshot.
 *   • `POST /admin/dlq/replay/:id`       — admin-only replay.
 *   • `POST /admin/dlq/discard/:id`      — admin-only discard.
 *
 * Every route is asserted in three shapes:
 *   1. No `authClaims` on the context → 403 Problem Details.
 *   2. `authClaims.role` not `'admin'` (member / coach) → 403.
 *   3. `authClaims.role === 'admin'` → 200 (or 404 on unknown id for
 *      the replay path).
 *
 * The suite builds a fresh {@link Hono} app per test, mounts the
 * router returned by {@link buildDlqRouter}, and installs a tiny
 * pre-middleware that seeds `traceId` + `authClaims` on the context
 * so the router can read them without the full gateway pipeline.
 *
 * A dedicated in-memory fake Redis (shared with `drain-dlq.test.ts`
 * via local duplication to keep each test file self-contained) is
 * injected through `__setDlqRedisForTests`.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDlqRouter } from '../admin/dlq-routes.js';
import { __resetDlqRedisCache, __setDlqRedisForTests } from '../events/drain-dlq.js';

import type { DlqAdminEnv } from '../admin/dlq-routes.js';
import type { DlqBindings } from '../events/drain-dlq.js';
import type { Queue } from '@cloudflare/workers-types';
import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Fake Redis (duplicate of the drain-dlq test's — kept local for     */
/*  self-contained test files)                                         */
/* ------------------------------------------------------------------ */

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

function asRedis(fake: FakeDlqRedis): Redis {
  return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEST_REDIS_URL = 'https://dlq-route-tests.upstash.io';

type Role = 'member' | 'admin' | 'coach';

/**
 * Build a Hono app wired with:
 *   • a seeding middleware that writes `traceId` and optionally
 *     `authClaims` onto the context before the router runs,
 *   • the router returned by {@link buildDlqRouter}.
 *
 * `role === null` means "no auth claims at all" — the unauthenticated
 * case.
 */
function buildApp(role: Role | null): {
  app: Hono<DlqAdminEnv>;
  env: DlqBindings;
  redis: FakeDlqRedis;
  eventsQueue: { send: ReturnType<typeof vi.fn> };
} {
  const redis = new FakeDlqRedis();
  __setDlqRedisForTests(TEST_REDIS_URL, asRedis(redis));

  const send = vi.fn<(msg: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const eventsQueue = { send };
  const eventsDlq = { send: vi.fn().mockResolvedValue(undefined) };

  const env: DlqBindings = {
    EVENTS_QUEUE: eventsQueue as unknown as Queue<unknown>,
    EVENTS_NOTIFICATIONS_QUEUE: eventsQueue as unknown as Queue<unknown>,
    EVENTS_RGPD_QUEUE: eventsQueue as unknown as Queue<unknown>,
    EVENTS_DLQ: eventsDlq as unknown as Queue<unknown>,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_TOKEN: 'test-token',
  };

  const app = new Hono<DlqAdminEnv>();

  // Seed the per-request context. `traceId` is required by every
  // Problem Details body the router emits; `authClaims` is the
  // admin gate.
  app.use('*', async (c, next) => {
    c.set('traceId', 'trace-test');
    if (role !== null) {
      c.set('authClaims', {
        userId: '00000000-0000-4000-8000-000000000001',
        studioId: '00000000-0000-4000-8000-000000000002',
        role,
      });
    }
    await next();
  });

  app.route('/', buildDlqRouter());

  return { app, env, redis, eventsQueue };
}

/** Seed a tracker entry so the replay / discard paths have data to act on. */
function seedEntry(
  redis: FakeDlqRedis,
  id: string,
  payload: unknown = { id, type: 'reservation.created' },
): void {
  redis.strings.set(
    `dlq:entry:${id}`,
    JSON.stringify({
      id,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      attempts: 1,
      payload,
      lastError: null,
    }),
  );
  redis.sets.set('dlq:pending', [
    ...(redis.sets.get('dlq:pending') ?? []),
    { score: 1_000, member: id },
  ]);
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  __resetDlqRedisCache();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDlqRedisCache();
});

/* ------------------------------------------------------------------ */
/*  GET /admin/dlq/stats                                               */
/* ------------------------------------------------------------------ */

describe('GET /admin/dlq/stats', () => {
  it('returns 403 Problem Details when no auth claims are set', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request('/admin/dlq/stats', { method: 'GET' }, env);

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      code: string;
    }>();
    expect(body.status).toBe(403);
    expect(body.title).toBe('Forbidden');
    expect(body.code).toBe('forbidden');
  });

  it('returns 403 for a member role', async () => {
    const { app, env } = buildApp('member');
    const res = await app.request('/admin/dlq/stats', { method: 'GET' }, env);
    expect(res.status).toBe(403);
  });

  it('returns 200 with the stats body for admin role', async () => {
    const { app, env, redis } = buildApp('admin');
    seedEntry(redis, 'a1', { id: 'a1' });
    seedEntry(redis, 'a2', { id: 'a2' });

    const res = await app.request('/admin/dlq/stats', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{
      pending: number;
      oldestAgeMs: number | null;
      entries: readonly { id: string }[];
    }>();
    expect(body.pending).toBe(2);
    expect(body.entries.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
  });
});

/* ------------------------------------------------------------------ */
/*  POST /admin/dlq/replay/:id                                         */
/* ------------------------------------------------------------------ */

describe('POST /admin/dlq/replay/:id', () => {
  it('returns 403 for a member role', async () => {
    const { app, env, redis } = buildApp('member');
    seedEntry(redis, 'secret-id');

    const res = await app.request('/admin/dlq/replay/secret-id', { method: 'POST' }, env);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('returns 200 and sends the payload on EVENTS_QUEUE for admin with a valid id', async () => {
    const { app, env, redis, eventsQueue } = buildApp('admin');
    const payload = { id: 'evt', type: 'reservation.created' };
    seedEntry(redis, 'good-id', payload);

    const res = await app.request('/admin/dlq/replay/good-id', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ replayed: boolean }>();
    expect(body).toEqual({ replayed: true });

    expect(eventsQueue.send).toHaveBeenCalledTimes(1);
    expect(eventsQueue.send).toHaveBeenCalledWith(payload);

    // Tracker entry removed so a subsequent replay returns 404.
    expect(redis.strings.has('dlq:entry:good-id')).toBe(false);
  });

  it('returns 404 Problem Details for admin on an unknown id', async () => {
    const { app, env } = buildApp('admin');
    const res = await app.request('/admin/dlq/replay/nope', { method: 'POST' }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      code: string;
    }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe('Not Found');
    expect(body.code).toBe('dlq_entry_not_found');
  });
});

/* ------------------------------------------------------------------ */
/*  POST /admin/dlq/discard/:id                                        */
/* ------------------------------------------------------------------ */

describe('POST /admin/dlq/discard/:id', () => {
  it('returns 403 for a coach role', async () => {
    const { app, env } = buildApp('coach');
    const res = await app.request('/admin/dlq/discard/some-id', { method: 'POST' }, env);
    expect(res.status).toBe(403);
  });

  it('returns 200 and removes the tracker entry for admin', async () => {
    const { app, env, redis } = buildApp('admin');
    seedEntry(redis, 'bye-id');

    const res = await app.request('/admin/dlq/discard/bye-id', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ discarded: boolean }>();
    expect(body).toEqual({ discarded: true });

    expect(redis.strings.has('dlq:entry:bye-id')).toBe(false);
  });

  it('returns 200 with discarded: true on an unknown id (idempotent)', async () => {
    const { app, env } = buildApp('admin');
    const res = await app.request('/admin/dlq/discard/ghost', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ discarded: boolean }>();
    expect(body.discarded).toBe(true);
  });
});
