/**
 * Sprint-1 SP1.2 — `/v1/auth/login` throttle wiring tests.
 *
 * Two scopes:
 *
 *   1. {@link deriveClientIp} — pure helper unit tests. Asserts the
 *      `CF-Connecting-IP > X-Forwarded-For[0] > 'unknown'` precedence
 *      that mirrors the rate-limit middleware's IP derivation. The
 *      shared definition guarantees the login throttle bucket and
 *      the global IP limiter agree on what "client IP" means.
 *
 *   2. Router-level wiring — asserts the login handler resolves an
 *      IP from request headers and forwards it to
 *      {@link AuthDeps.login} via the new {@link LoginContext}
 *      argument. This is the gateway side of the Req 1.6 throttle
 *      contract; the Upstash bucket evaluation itself is owned and
 *      unit-tested by `@athlya/auth` (`packages/auth/src/throttle.ts`).
 *
 * Validates: Requirements 1.6 (login-attempt throttle), 14.3 (IP
 * limit baseline shared with the global limiter).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { deriveClientIp } from '../../routes/helpers.js';

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
/*  deriveClientIp                                                     */
/* ------------------------------------------------------------------ */

describe('deriveClientIp', () => {
  it('returns the trimmed CF-Connecting-IP when set, ignoring X-Forwarded-For', () => {
    expect(deriveClientIp('  203.0.113.7  ', '198.51.100.1')).toBe('203.0.113.7');
  });

  it('falls back to the FIRST X-Forwarded-For token when CF header is absent', () => {
    expect(deriveClientIp(undefined, '198.51.100.1, 203.0.113.7, 10.0.0.1')).toBe('198.51.100.1');
  });

  it('trims surrounding whitespace on the first XFF token', () => {
    expect(deriveClientIp(undefined, '  198.51.100.1 , 203.0.113.7')).toBe('198.51.100.1');
  });

  it('treats an empty CF-Connecting-IP as absent and falls through to XFF', () => {
    expect(deriveClientIp('', '198.51.100.1')).toBe('198.51.100.1');
    expect(deriveClientIp('   ', '198.51.100.1')).toBe('198.51.100.1');
  });

  it("returns 'unknown' when both headers are missing or blank", () => {
    expect(deriveClientIp(undefined, undefined)).toBe('unknown');
    expect(deriveClientIp('', '')).toBe('unknown');
    expect(deriveClientIp('   ', '   ,   ')).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/*  POST /v1/auth/login wiring                                         */
/* ------------------------------------------------------------------ */

describe('POST /v1/auth/login — LoginContext wiring', () => {
  /**
   * The `cf-turnstile-token` header is required by the public-form
   * Turnstile gate (Req 26.1). The mock env runs in `dev`, so the
   * gate emits a warn and lets the request through; the handler is
   * still reached and we can observe `deps.login` having been
   * called with a `LoginContext`.
   */
  const VALID_LOGIN_BODY = JSON.stringify({
    email: 'ada@example.com',
    password: 'Password1234',
  });

  it('forwards CF-Connecting-IP to deps.login as { ip }', async () => {
    const session = {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 86_400,
      user: { id: 'u1', email: 'ada@example.com' },
    };
    const loginSpy = vi.fn(async (_req: unknown, _ctx: unknown) => session);
    const deps = buildStubDeps({
      auth: {
        login: loginSpy,
      },
    });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
          'x-forwarded-for': '198.51.100.1',
          // Empty token is enough in dev — turnstile bypasses.
          'cf-turnstile-token': 'dev-skip',
        },
        body: VALID_LOGIN_BODY,
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    const args = loginSpy.mock.calls[0]!;
    expect(args[1]).toEqual({ ip: '203.0.113.42' });
  });

  it('falls back to X-Forwarded-For[0] when CF-Connecting-IP is absent', async () => {
    const session = {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 86_400,
      user: { id: 'u1', email: 'ada@example.com' },
    };
    const loginSpy = vi.fn(async (_req: unknown, _ctx: unknown) => session);
    const deps = buildStubDeps({
      auth: {
        login: loginSpy,
      },
    });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.1, 203.0.113.7',
          'cf-turnstile-token': 'dev-skip',
        },
        body: VALID_LOGIN_BODY,
      },
      env(),
    );

    expect(res.status).toBe(200);
    const args = loginSpy.mock.calls[0]!;
    expect(args[1]).toEqual({ ip: '198.51.100.1' });
  });

  it("forwards 'unknown' when no IP header is present", async () => {
    const session = {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 86_400,
      user: { id: 'u1', email: 'ada@example.com' },
    };
    const loginSpy = vi.fn(async (_req: unknown, _ctx: unknown) => session);
    const deps = buildStubDeps({
      auth: {
        login: loginSpy,
      },
    });
    const app = buildTestApp(deps);

    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-turnstile-token': 'dev-skip',
        },
        body: VALID_LOGIN_BODY,
      },
      env(),
    );

    expect(res.status).toBe(200);
    const args = loginSpy.mock.calls[0]!;
    expect(args[1]).toEqual({ ip: 'unknown' });
  });
});
