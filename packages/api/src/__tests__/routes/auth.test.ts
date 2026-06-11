/**
 * Unit tests for the `/v1/auth/*` domain router (task 8.11).
 *
 * Exercises the middleware chain and handler wiring:
 *
 *   1. `POST /register` rejects when the Turnstile header is absent
 *      (403 `bot_challenge_failed`).
 *   2. `POST /login` rejects when Turnstile is absent (403).
 *   3. `POST /password-reset/request` and `/confirm` reject without Turnstile (403).
 *   4. `POST /refresh` rejects an invalid body with 422 (no
 *      Turnstile requirement).
 *   5. `POST /logout` without Authorization returns 401.
 *   6. `DELETE /me` without Authorization returns 401.
 *   7. `POST /refresh` on the happy path forwards to `deps.refresh`
 *      and returns its payload.
 *
 * Slice B8.4 â€” the `/login-with-apple` and `/login-with-google`
 * routes were removed from the router; the corresponding tests
 * (validation, provider override) were dropped in lockstep. The
 * OAuth wiring will return in a dedicated slice once Apple / Google
 * developer credentials are provisioned (see
 * `docs/modifications/modifications.md` Â§ Vague 20).
 *
 * Validates: Requirements 14.1, 14.2, 26.3 (Turnstile-behind
 * public forms).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/read-json.js';

import { buildStubDeps, buildTestApp, env } from './route-test-helpers.js';

/* ------------------------------------------------------------------ */
/*  Console silencing                                                  */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('POST /v1/auth/register', () => {
  it('rejects a request without the cf-turnstile-token header with 403 bot_challenge_failed', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Password1234',
          displayName: 'Ada',
          studioSlug: 'athlya-paris',
          consents: {
            marketing: false,
            analytics: false,
            thirdParty: false,
          },
        }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
    expect(body.code).toBe('bot_challenge_failed');
    expect(body.status).toBe(403);
    expect(deps.auth.register).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/login', () => {
  it('rejects a request without the cf-turnstile-token header with 403', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'hunter2',
        }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    expect(deps.auth.login).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/refresh', () => {
  it('returns 422 when the body lacks a refreshToken', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      env(),
    );

    expect(res.status).toBe(422);
    expect(deps.auth.refresh).not.toHaveBeenCalled();
  });

  it('happy path: forwards to deps.refresh and returns the session', async () => {
    const session = {
      accessToken: 'a.t',
      refreshToken: 'r.t',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2_592_000,
      user: { id: 'u1' },
    };
    const deps = buildStubDeps({
      auth: {
        refresh: vi.fn().mockResolvedValue(session),
      },
    });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'r.old' }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.accessToken).toBe('a.t');
    expect(deps.auth.refresh).toHaveBeenCalledTimes(1);
    expect(deps.auth.refresh).toHaveBeenCalledWith({
      refreshToken: 'r.old',
    });
  });

  it('returns 429 rate_limit_exceeded when checkRefreshRateLimit returns false (issue #240)', async () => {
    const checkRefreshRateLimit = vi.fn().mockResolvedValue(false);
    const deps = buildStubDeps({ auth: { checkRefreshRateLimit } });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'r.stolen' }),
      },
      env(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('rate_limit_exceeded');
    expect(checkRefreshRateLimit).toHaveBeenCalledWith('r.stolen');
    expect(deps.auth.refresh).not.toHaveBeenCalled();
  });

  it('forwards to deps.refresh when checkRefreshRateLimit returns true', async () => {
    const session = {
      accessToken: 'a.t2',
      refreshToken: 'r.t2',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2_592_000,
      user: { id: 'u2' },
    };
    const checkRefreshRateLimit = vi.fn().mockResolvedValue(true);
    const deps = buildStubDeps({
      auth: { checkRefreshRateLimit, refresh: vi.fn().mockResolvedValue(session) },
    });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'r.valid' }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(checkRefreshRateLimit).toHaveBeenCalledWith('r.valid');
    expect(deps.auth.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/auth/logout', () => {
  it('returns 401 missing_authorization when no Authorization header is sent', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/auth/logout', { method: 'POST' }, env());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
    expect(body.title).toBe('missing_authorization');
    expect(deps.auth.logout).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/auth/me', () => {
  it('returns 401 missing_authorization without Authorization header', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request('/v1/auth/me', { method: 'DELETE' }, env());

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.title).toBe('missing_authorization');
    expect(deps.auth.deleteMe).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/password-reset/request', () => {
  it('rejects a request without the cf-turnstile-token header with 403 bot_challenge_failed', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/password-reset/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('bot_challenge_failed');
    expect(deps.auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('returns 429 rate_limit_exceeded when the per-email reset limit is hit', async () => {
    const checkPasswordResetRateLimit = vi.fn().mockResolvedValue(false);
    const deps = buildStubDeps({ auth: { checkPasswordResetRateLimit } });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/password-reset/request',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-turnstile-token': 'test-token',
        },
        body: JSON.stringify({ email: 'ada@example.com' }),
      },
      env(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('rate_limit_exceeded');
    expect(checkPasswordResetRateLimit).toHaveBeenCalledWith('ada@example.com');
    expect(deps.auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('forwards to requestPasswordReset when under the per-email limit', async () => {
    const checkPasswordResetRateLimit = vi.fn().mockResolvedValue(true);
    const deps = buildStubDeps({ auth: { checkPasswordResetRateLimit } });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/password-reset/request',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-turnstile-token': 'test-token',
        },
        body: JSON.stringify({ email: 'ada@example.com' }),
      },
      env(),
    );

    expect(res.status).toBe(204);
    expect(checkPasswordResetRateLimit).toHaveBeenCalledWith('ada@example.com');
    expect(deps.auth.requestPasswordReset).toHaveBeenCalledWith('ada@example.com');
  });
});

describe('POST /v1/auth/password-reset/confirm', () => {
  it('rejects a request without the cf-turnstile-token header with 403 bot_challenge_failed', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/password-reset/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'reset-token', newPassword: 'Password1234' }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('bot_challenge_failed');
    expect(deps.auth.confirmPasswordReset).not.toHaveBeenCalled();
  });
});

describe('OAuth routes (removed in B8.4)', () => {
  it('returns 404 on POST /v1/auth/login-with-apple (route removed)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);
    const res = await app.request(
      '/v1/auth/login-with-apple',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'x.y.z' }),
      },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST /v1/auth/login-with-google (route removed)', async () => {
    const deps = buildStubDeps();
    const app = buildTestApp(deps);
    const res = await app.request(
      '/v1/auth/login-with-google',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'x.y.z' }),
      },
      env(),
    );
    expect(res.status).toBe(404);
  });
});
