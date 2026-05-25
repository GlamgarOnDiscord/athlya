/**
 * Unit tests for the `/v1/classes/*` domain router (task 8.11).
 *
 * Covers:
 *   1. GET / â†’ 401 without Authorization (auth chain proof).
 *   2. POST / â†’ 401 without Authorization (admin-only path still
 *      requires authentication before the role gate).
 *   3. PATCH /:id â†’ 401 without Authorization.
 *   4. GET / with a bogus `to` param â†’ the validator would run only
 *      post-auth, so 401 still fires first (proves chain order).
 *   5. DELETE without auth is handled by the 404 notFound (no DELETE
 *      route on the classes router).
 *   6. Problem Details envelope on every 401 response.
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

describe('/v1/classes â€” unauthenticated requests', () => {
  it('GET / without Authorization â†’ 401 missing_authorization', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/classes/?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z',
      { method: 'GET' },
      env(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
    expect(body.title).toBe('missing_authorization');
    expect(deps.classes.listClasses).not.toHaveBeenCalled();
  });

  it('POST / (admin-only) â†’ 401 without Authorization (auth runs before role check)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/classes/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'HIIT',
          startsAt: '2026-02-01T09:00:00Z',
          durationMin: 45,
          capacity: 20,
        }),
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.classes.createClass).not.toHaveBeenCalled();
  });

  it('PATCH /:id â†’ 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/classes/11111111-1111-4111-8111-111111111111',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed', version: 0 }),
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.classes.updateClass).not.toHaveBeenCalled();
  });

  it('GET / with malformed query still surfaces auth 401 first (auth fires before validator)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/classes/?from=invalid-date&to=also-invalid',
      { method: 'GET' },
      env(),
    );

    // 401 (auth) wins over 422 (validator) because the chain is
    // jwtAuth â†’ zValidator. If 422 came back we would know the
    // validator ran before auth â€” a security regression.
    expect(res.status).toBe(401);
  });

  it('unsupported methods (DELETE) still surface 401 first because jwtAuth fronts the whole router', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    // The classes router mounts `jwtAuth` on `router.use('*',
    // ...)`, so a DELETE to `/v1/classes/` surfaces 401 before
    // the route miss would emit 404.
    const res = await app.request('/v1/classes/', { method: 'DELETE' }, env());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('Problem Details 401 carries trace id matching x-trace-id header', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/classes/?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z',
      { method: 'GET' },
      env(),
    );

    const body = (await res.json()) as any;
    const xTraceId = res.headers.get('x-trace-id');
    expect(body.traceId).toBe(xTraceId);
  });

  it('GET /search without Authorization → 401 (auth runs before validator)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/classes/search?q=hiit', { method: 'GET' }, env());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(deps.classes.searchClasses).not.toHaveBeenCalled();
  });
});
