/**
 * Unit tests for the `/v1/members/*` domain router (task 8.11).
 *
 * Covers:
 *   1. `GET /me` without Authorization â†’ 401 `missing_authorization`.
 *   2. `PATCH /me` without Authorization â†’ 401.
 *   3. `POST /me/export` without Authorization â†’ 401.
 *   4. `GET /` without Authorization â†’ 401.
 *   5. `GET /` (admin endpoint) returns 401 â€” the chain proves
 *      `jwtAuth` runs before `requireRole`.
 *   6. `PATCH /me/consents` on an unauthenticated request â†’ 401.
 *
 * Authenticated-path assertions (admin-only 403 for members, export
 * returning 202) require a working JWKS resolver; those live with
 * the task 8.12 integration suite when a concrete adapter ships.
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

describe('/v1/members â€” unauthenticated requests', () => {
  it('GET /me â†’ 401 missing_authorization', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/members/me', { method: 'GET' }, env());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
    expect(body.title).toBe('missing_authorization');
    expect(deps.members.getProfile).not.toHaveBeenCalled();
  });

  it('PATCH /me â†’ 401 (auth runs before validator)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/members/me',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Ada' }),
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.members.updateProfile).not.toHaveBeenCalled();
  });

  it('POST /me/export â†’ 401 (jwtAuth fronts the RGPD enqueue)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/members/me/export', { method: 'POST' }, env());

    expect(res.status).toBe(401);
    expect(deps.members.enqueueExport).not.toHaveBeenCalled();
  });

  it('GET / (admin listing) â†’ 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/members/', { method: 'GET' }, env());

    expect(res.status).toBe(401);
    expect(deps.members.listMembersByStudio).not.toHaveBeenCalled();
  });

  it('PATCH /me/consents â†’ 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/members/me/consents',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          marketing: true,
          analytics: false,
          thirdParty: false,
        }),
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.members.updateConsents).not.toHaveBeenCalled();
  });

  it('Problem Details envelope on every 401 carries a traceId matching x-trace-id', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/members/me', { method: 'GET' }, env());

    const body = (await res.json()) as any;
    const xTraceId = res.headers.get('x-trace-id');
    expect(xTraceId).not.toBeNull();
    expect(body.traceId).toBe(xTraceId);
  });
});
