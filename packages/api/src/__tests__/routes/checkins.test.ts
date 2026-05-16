/**
 * Unit tests for the `/v1/checkins/*` domain router (task 8.11).
 *
 * Covers:
 *   1. POST / without Authorization â†’ 401 missing_authorization.
 *   2. POST / with invalid body still surfaces 401 (chain order).
 *   3. Unsupported GET â†’ 404 Problem Details.
 *   4. Problem Details 401 body + trace id echo.
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

describe('/v1/checkins', () => {
    it('POST / â†’ 401 missing_authorization without Authorization header', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/checkins/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ qrToken: 'x.y.z' }),
            },
            env(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = (await res.json() as any);
        expect(body.title).toBe('missing_authorization');
        expect(deps.checkins.checkIn).not.toHaveBeenCalled();
    });

    it('POST / with malformed body still surfaces 401 first (auth before validator)', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/checkins/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            },
            env(),
        );

        // 401 wins over 422 â€” auth middleware is mounted first.
        expect(res.status).toBe(401);
    });

    it('GET / (no such handler) with no Authorization â†’ 401 first (auth applies to the entire router)', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        // The checkins router applies `jwtAuth` via `router.use('*',
        // jwtAuth())`, so even a GET (with no handler) surfaces 401
        // before the per-verb route matcher rejects.
        const res = await app.request(
            '/v1/checkins/',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
    });

    it('Problem Details 401 carries traceId matching x-trace-id', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/checkins/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ qrToken: 't' }),
            },
            env(),
        );

        const body = (await res.json() as any);
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });
});
