/**
 * Unit tests for the idempotency middleware.
 *
 * Covers the six scenarios called out in task 4.2:
 *   1. No `Idempotency-Key` header → pass-through.
 *   2. GET with `Idempotency-Key` → pass-through (read-only verbs skip).
 *   3. POST cache miss, handler returns 2xx → `store()` called.
 *   4. POST cache hit → handler never invoked, response matches cache.
 *   5. Missing `userId` context → pass-through without lookup or store.
 *   6. Empty or oversized key → HTTP 400 `invalid_idempotency_key`.
 *
 * The tests exercise the middleware through a real Hono `app.request`
 * call so the request/response lifecycle matches production. The DB
 * helpers are replaced with `vi.fn()`s via `vi.mock`, which is enough
 * because the middleware only calls `lookup` / `store` — no SQL is
 * actually issued.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IDEMPOTENCY_TTL_SEC,
  IDEMPOTENCY_REQUEST_HASH_FIELD,
  idempotencyMiddleware,
  type IdempotencyInFlightLock,
  type IdempotencyEnv,
  type IdempotencyLogger,
  type IdempotencyMiddlewareDeps,
} from '../middleware/idempotency.js';

import { readJson } from './helpers/read-json.js';

import type { AthlyaDb } from '@athlya/db/client';
import type { IdempotencyEntry } from '@athlya/db/idempotency';
import type { Context } from 'hono';

// Replace the DB helpers with Vitest mocks. `vi.mock` is hoisted above
// the import, so we declare mock fns via `vi.hoisted` to keep them
// addressable from within the tests.
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@athlya/db/idempotency', () => ({
  lookup: mocks.lookup,
  store: mocks.store,
}));

const USER_ID = '00000000-0000-4000-8000-000000000001';

/** Build a silent logger so the test output stays readable. */
function silentLogger(): IdempotencyLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

/**
 * Build a Hono app with:
 *   - an auth-stand-in that injects `userId` on a configurable flag,
 *   - the idempotency middleware under test,
 *   - two probe routes (GET and POST) that let us inspect what the
 *     downstream handler saw.
 */
function buildApp(
  options: {
    injectUserId?: boolean;
    handlerResponse?: { status: number; body: unknown; contentType?: string };
    deps?: Partial<IdempotencyMiddlewareDeps>;
  } = {},
) {
  const handlerSpy = vi.fn();
  const app = new Hono<IdempotencyEnv>();

  if (options.injectUserId !== false) {
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      await next();
    });
  }

  const deps: IdempotencyMiddlewareDeps = {
    // The middleware never introspects the db handle directly; it
    // is forwarded verbatim to the mocked `lookup` / `store`, so a
    // plain object is enough.
    db: {} as AthlyaDb,
    logger: silentLogger(),
    ...options.deps,
  };

  app.use('*', idempotencyMiddleware(deps));

  const respond = (c: Context<IdempotencyEnv>) => {
    handlerSpy();
    const resp = options.handlerResponse ?? {
      status: 201,
      body: { id: 'resv-1' },
    };
    if (resp.contentType !== undefined) {
      return c.body(
        typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body),
        resp.status as 200,
        { 'content-type': resp.contentType },
      );
    }
    return c.json(resp.body as any, resp.status as 200);
  };

  app.get('/resource', respond);
  app.post('/resource', respond);

  return { app, handlerSpy };
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.store.mockReset();
  mocks.lookup.mockResolvedValue(null);
  mocks.store.mockResolvedValue(undefined);
});

describe('idempotencyMiddleware', () => {
  it('case 1: passes POST through when no Idempotency-Key is sent', async () => {
    const { app, handlerSpy } = buildApp();

    const res = await app.request('/resource', { method: 'POST' });

    expect(res.status).toBe(201);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('case 2: passes GET through even when Idempotency-Key is sent', async () => {
    const { app, handlerSpy } = buildApp();

    const res = await app.request('/resource', {
      method: 'GET',
      headers: { 'Idempotency-Key': 'abc' },
    });

    expect(res.status).toBe(201);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('case 3: on cache miss, runs the handler and stores the 2xx response', async () => {
    const { app, handlerSpy } = buildApp({
      handlerResponse: { status: 201, body: { id: 'resv-1' } },
    });
    mocks.lookup.mockResolvedValueOnce(null);

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k1' },
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: 'resv-1' });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).toHaveBeenCalledWith(expect.anything(), 'k1', USER_ID);
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.store).toHaveBeenCalledWith(
      expect.anything(),
      'k1',
      USER_ID,
      { body: { id: 'resv-1' }, statusCode: 201 },
      DEFAULT_IDEMPOTENCY_TTL_SEC,
    );
  });

  it('case 3b: custom ttlSec is forwarded to store', async () => {
    const { app } = buildApp({
      deps: { ttlSec: 3_600 },
      handlerResponse: { status: 200, body: { ok: true } },
    });

    await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-ttl' },
    });

    expect(mocks.store).toHaveBeenCalledWith(
      expect.anything(),
      'k-ttl',
      USER_ID,
      { body: { ok: true }, statusCode: 200 },
      3_600,
    );
  });

  it('case 3c: also stores on 409 so replay of conflicts is stable', async () => {
    const { app } = buildApp({
      handlerResponse: { status: 409, body: { title: 'already_booked' } },
    });

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-conflict' },
    });

    expect(res.status).toBe(409);
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it('case 3d: does NOT store non-2xx/409 responses (e.g. 422 validation error)', async () => {
    const { app } = buildApp({
      handlerResponse: {
        status: 422,
        body: { title: 'invalid_input' },
      },
    });

    await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-422' },
    });

    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('case 4: on cache hit, short-circuits without invoking the handler', async () => {
    const { app, handlerSpy } = buildApp();

    const cached: IdempotencyEntry = {
      response: { id: 'resv-cached' },
      statusCode: 201,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      expiresAt: new Date('2025-01-02T00:00:00Z'),
    };
    mocks.lookup.mockResolvedValueOnce(cached);

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-hit' },
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: 'resv-cached' });
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('case 5: passes through without caching when userId is absent', async () => {
    const { app, handlerSpy } = buildApp({ injectUserId: false });

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-anonymous' },
    });

    expect(res.status).toBe(201);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('case 6a: rejects an empty Idempotency-Key with 400', async () => {
    const { app, handlerSpy } = buildApp();

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': '   ' },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_idempotency_key');
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('case 6b: rejects an oversized Idempotency-Key with 400', async () => {
    const { app, handlerSpy } = buildApp();

    const oversized = 'x'.repeat(256);
    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': oversized },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_idempotency_key');
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('skips storage when the handler returns a non-JSON body', async () => {
    const { app } = buildApp({
      handlerResponse: {
        status: 201,
        body: 'plain-text',
        contentType: 'text/plain',
      },
    });

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-nonjson' },
    });

    expect(res.status).toBe(201);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('swallows storage errors so the primary response survives', async () => {
    const logger = silentLogger();
    const { app } = buildApp({
      deps: { logger },
      handlerResponse: { status: 201, body: { id: 'ok' } },
    });
    mocks.store.mockRejectedValueOnce(new Error('redis down'));

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-store-fail' },
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: 'ok' });
    expect(logger.warn).toHaveBeenCalledWith(
      'store failed; continuing without cache',
      expect.objectContaining({
        error: expect.objectContaining({ message: 'redis down' }) as unknown,
      }),
    );
  });

  it('degrades gracefully when lookup throws, running the handler instead', async () => {
    const logger = silentLogger();
    const { app, handlerSpy } = buildApp({
      deps: { logger },
      handlerResponse: { status: 200, body: { ok: true } },
    });
    mocks.lookup.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await app.request('/resource', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-lookup-fail' },
    });

    expect(res.status).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'lookup failed',
      expect.objectContaining({
        error: expect.objectContaining({ message: 'db unreachable' }) as unknown,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Strict mode: in-flight marker, request hash, fail closed           */
/* ------------------------------------------------------------------ */

/** In-memory marker with the same NX + token semantics as Redis. */
function memoryLock(): IdempotencyInFlightLock & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    acquire: vi.fn((key: string, token: string) => {
      if (held.has(key)) return Promise.resolve(false);
      held.set(key, token);
      return Promise.resolve(true);
    }),
    release: vi.fn((key: string, token: string) => {
      if (held.get(key) === token) held.delete(key);
      return Promise.resolve();
    }),
  };
}

function strictDeps(
  inFlight: IdempotencyInFlightLock = memoryLock(),
): Partial<IdempotencyMiddlewareDeps> {
  return { inFlight, bindRequest: true, failClosed: true };
}

function post(app: ReturnType<typeof buildApp>['app'], key: string, body = '{"classId":"c1"}') {
  return app.request('/resource', {
    method: 'POST',
    headers: { 'Idempotency-Key': key, 'content-type': 'application/json' },
    body,
  });
}

describe('idempotencyMiddleware: strict mode', () => {
  it('stores the request hash with the body and strips it on replay', async () => {
    const { app, handlerSpy } = buildApp({ deps: strictDeps() });

    const first = await post(app, 'k-strict');
    expect(first.status).toBe(201);
    const stored = mocks.store.mock.calls[0]?.[3] as { body: Record<string, unknown> };
    const hash = stored.body[IDEMPOTENCY_REQUEST_HASH_FIELD];
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);

    mocks.lookup.mockResolvedValue({ response: stored.body, statusCode: 201 });
    const replay = await post(app, 'k-strict');

    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    await expect(readJson<Record<string, unknown>>(replay)).resolves.toEqual({ id: 'resv-1' });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a key reused with a different body with 422 idempotency_key_reused', async () => {
    const { app, handlerSpy } = buildApp({ deps: strictDeps() });
    await post(app, 'k-reuse', '{"classId":"c1"}');
    const stored = mocks.store.mock.calls[0]?.[3] as { body: Record<string, unknown> };
    mocks.lookup.mockResolvedValue({ response: stored.body, statusCode: 201 });

    const res = await post(app, 'k-reuse', '{"classId":"c2"}');

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    await expect(readJson<{ code: string }>(res)).resolves.toMatchObject({
      type: 'about:blank',
      title: 'idempotency_key_reused',
      status: 422,
      code: 'idempotency_key_reused',
    });
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('replays an entry stored before the hash existed', async () => {
    const { app, handlerSpy } = buildApp({ deps: strictDeps() });
    mocks.lookup.mockResolvedValue({ response: { id: 'legacy' }, statusCode: 201 });

    const res = await post(app, 'k-legacy');

    expect(res.status).toBe(201);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toEqual({ id: 'legacy' });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('answers 409 idempotency_in_progress with Retry-After while a duplicate is in flight', async () => {
    const lock = memoryLock();
    lock.held.set(`idem:inflight:${USER_ID}:k-busy`, 'other-request');
    const { app, handlerSpy } = buildApp({ deps: strictDeps(lock) });

    const res = await post(app, 'k-busy');

    expect(res.status).toBe(409);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    await expect(readJson<{ code: string }>(res)).resolves.toMatchObject({
      status: 409,
      code: 'idempotency_in_progress',
    });
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('carries the request traceId on a strict-mode problem', async () => {
    const lock = memoryLock();
    lock.held.set(`idem:inflight:${USER_ID}:k-trace`, 'other-request');
    const app = new Hono<IdempotencyEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      (c as unknown as { set: (key: string, value: unknown) => void }).set('traceId', 'trace-1');
      await next();
    });
    app.use(
      '*',
      idempotencyMiddleware({ db: {} as AthlyaDb, logger: silentLogger(), ...strictDeps(lock) }),
    );
    app.post('/resource', (c) => c.json({ id: 'never' }, 201));

    const res = await post(app, 'k-trace');

    expect(res.status).toBe(409);
    await expect(readJson<{ traceId: string }>(res)).resolves.toMatchObject({
      traceId: 'trace-1',
    });
  });

  it('runs a single handler when two identical requests race', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handlerSpy = vi.fn();
    const app = new Hono<IdempotencyEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      await next();
    });
    app.use(
      '*',
      idempotencyMiddleware({ db: {} as AthlyaDb, logger: silentLogger(), ...strictDeps() }),
    );
    app.post('/resource', async (c) => {
      handlerSpy();
      await gate;
      return c.json({ id: 'once' }, 201);
    });

    const first = post(app, 'k-race');
    const second = await post(app, 'k-race');
    release();
    const winner = await first;

    expect(winner.status).toBe(201);
    expect(second.status).toBe(409);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('replays instead of re-running when the duplicate finished before the marker was taken', async () => {
    const { app, handlerSpy } = buildApp({ deps: strictDeps() });
    mocks.lookup
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ response: { id: 'resv-1' }, statusCode: 201 });

    const res = await post(app, 'k-double-check');

    expect(res.status).toBe(201);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('releases the marker after the handler, so a later retry replays', async () => {
    const lock = memoryLock();
    const { app } = buildApp({ deps: strictDeps(lock) });

    await post(app, 'k-release');

    expect(lock.held.size).toBe(0);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 503 when the lookup store is unreachable', async () => {
    const { app, handlerSpy } = buildApp({ deps: strictDeps() });
    mocks.lookup.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await post(app, 'k-down');

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    await expect(readJson<{ code: string }>(res)).resolves.toMatchObject({
      status: 503,
      code: 'idempotency_unavailable',
    });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the in-flight marker cannot be taken', async () => {
    const lock = memoryLock();
    vi.mocked(lock.acquire).mockRejectedValueOnce(new Error('redis down'));
    const { app, handlerSpy } = buildApp({ deps: strictDeps(lock) });

    const res = await post(app, 'k-redis-down');

    expect(res.status).toBe(503);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('returns the committed response when only the final store write fails', async () => {
    const logger = silentLogger();
    const { app } = buildApp({ deps: { ...strictDeps(), logger } });
    mocks.store.mockRejectedValueOnce(new Error('db blip'));

    const res = await post(app, 'k-store-down');

    expect(res.status).toBe(201);
    expect(logger.error).toHaveBeenCalledWith(
      'store failed after the mutation; continuing without cache',
      expect.objectContaining({ key: 'k-store-down' }),
    );
  });
});
