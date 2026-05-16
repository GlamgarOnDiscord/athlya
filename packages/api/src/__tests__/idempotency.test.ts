/**
 * Unit tests for the idempotency middleware.
 *
 * Covers the six scenarios called out in task 4.2:
 *   1. No `Idempotency-Key` header → pass-through.
 *   2. GET with `Idempotency-Key` → pass-through (read-only verbs skip).
 *   3. POST cache miss, handler returns 2xx → `store()` called.
 *   4. POST cache hit → handler never invoked, response matches cache.
 *   5. Missing `userId` context → middleware throws (programmer error).
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
    idempotencyMiddleware,
    type IdempotencyEnv,
    type IdempotencyLogger,
    type IdempotencyMiddlewareDeps,
} from '../middleware/idempotency.js';

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
function buildApp(options: {
    injectUserId?: boolean;
    handlerResponse?: { status: number; body: unknown; contentType?: string };
    deps?: Partial<IdempotencyMiddlewareDeps>;
} = {}) {
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
        expect(mocks.lookup).toHaveBeenCalledWith(
            expect.anything(),
            'k1',
            USER_ID,
        );
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

    it('case 5: throws when userId is absent from the context', async () => {
        const { app } = buildApp({ injectUserId: false });

        // Hono catches handler errors and returns 500 by default, but
        // the `onError` default also logs to stderr. We assert the
        // status rather than rely on the error surfacing through the
        // fetch call.
        app.onError((err, c) => c.json({ thrown: err.message }, 500));

        const res = await app.request('/resource', {
            method: 'POST',
            headers: { 'Idempotency-Key': 'k-missing-user' },
        });

        expect(res.status).toBe(500);
        const body = await res.json<{ thrown: string }>();
        expect(body.thrown).toMatch(/userId missing/);
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
