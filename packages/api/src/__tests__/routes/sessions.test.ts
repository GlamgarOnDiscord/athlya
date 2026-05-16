/**
 * Unit tests for the `/v1/sessions/*` domain router (task 8.11).
 *
 * Covers:
 *   1. POST / without Authorization â†’ 401 missing_authorization.
 *   2. GET /me without Authorization â†’ 401.
 *   3. POST / with an invalid body still 401 (auth chain order).
 *   4. GET /me with no query still 401.
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

describe('/v1/sessions â€” unauthenticated requests', () => {
    it('POST / â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/sessions/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    startedAt: '2026-01-01T09:00:00Z',
                    exercises: [],
                }),
            },
            env(),
        );

        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(deps.sessions.logSession).not.toHaveBeenCalled();
    });

    it('GET /me â†’ 401 missing_authorization', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/sessions/me?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.sessions.listSessions).not.toHaveBeenCalled();
    });

    it('POST / with oversized exercises array still surfaces 401 first (auth before validator)', async () => {
        // 51 exercises exceeds the Zod `.max(50)` cap from
        // LogSessionRequestSchema. Without authentication the chain
        // MUST stop at 401 â€” a 422 would prove the validator ran
        // before auth.
        const exercises = Array.from({ length: 51 }, (_, i) => ({
            name: `ex${i}`,
            sets: [{ reps: 10 }],
        }));
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/sessions/',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    startedAt: '2026-01-01T09:00:00Z',
                    exercises,
                }),
            },
            env(),
        );

        expect(res.status).toBe(401);
    });

    it('Problem Details 401 carries traceId matching x-trace-id', async () => {
        const deps = buildStubDeps();
        const app = buildTestApp(deps);

        const res = await app.request(
            '/v1/sessions/me',
            { method: 'GET' },
            env(),
        );

        const body = await res.json() as Record<string, unknown>;
        expect(body.traceId).toBe(res.headers.get('x-trace-id'));
    });
});
