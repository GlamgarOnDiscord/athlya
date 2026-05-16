/**
 * Unit tests for the `/v1/reservations/*` domain router (task 8.11).
 *
 * Covers:
 *   1. POST / without Authorization â†’ 401 missing_authorization.
 *   2. DELETE /:id without Authorization â†’ 401.
 *   3. GET /me without Authorization â†’ 401.
 *   4. POST / with malformed body still 401 (auth before validator).
 *   5. DELETE /:id with a non-UUID id still 401 (auth chain order).
 *   6. Problem Details envelope shape check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStubDeps, buildTestApp, env } from './route-test-helpers.js';

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('/v1/reservations â€” unauthenticated requests', () => {
    it('POST / â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    classId: '11111111-1111-4111-8111-111111111111',
                }),
            },
            env(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json() as Record<string, unknown>;
        expect(body.title).toBe('missing_authorization');
        expect(deps.reservations.bookClass).not.toHaveBeenCalled();
    });

    it('DELETE /:id â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/22222222-2222-4222-8222-222222222222',
            { method: 'DELETE' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.reservations.cancelReservation).not.toHaveBeenCalled();
    });

    it('GET /me â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/me',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.reservations.listMyReservations).not.toHaveBeenCalled();
    });

    it('POST / with malformed body still surfaces auth 401 first', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not json',
            },
            env(),
        );

        // Chain order: jwtAuth fires before zValidator. We MUST see
        // 401 here; 422 would prove a regression.
        expect(res.status).toBe(401);
    });

    it('DELETE /:id with non-UUID path param still surfaces 401 first', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/not-a-uuid',
            { method: 'DELETE' },
            env(),
        );

        expect(res.status).toBe(401);
    });

    it('Problem Details 401 envelope carries the 4-field minimum + traceId', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/reservations/me',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        const body = await res.json() as Record<string, unknown>;
        expect(body.type).toBe('about:blank');
        expect(body.status).toBe(401);
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });
});
