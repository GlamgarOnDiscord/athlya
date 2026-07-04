/**
 * Route handler tests for `POST /api/auth/register`.
 *
 * Five cases match the contract:
 *  1. Valid body → upstream 201 → response strips refreshToken AND
 *     Set-Cookie is present with the expected attributes.
 *  2. Invalid body (missing email) → route handler emits 422
 *     Problem Details without hitting the upstream.
 *  3. Upstream 422 (e.g. password_breached) → forwarded verbatim with
 *     no cookie set.
 *  4. Upstream 403 Turnstile fail → forwarded verbatim.
 *  5. Missing `cf-turnstile-token` header → forwarded as empty string
 *     so the gateway's Turnstile middleware rejects it (Req 26.3).
 *
 * We stub `globalThis.fetch` via `vi.fn()` — no real server is spun
 * up. `NextRequest` is constructed directly from the `next/server`
 * export.
 *
 * @see Requirements 1.1, 1.2, 2.3, 26.1, 26.2, 26.3.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

/** Helper: minimal valid register payload. */
function validBody(): Record<string, unknown> {
  return {
    email: 'alice@example.com',
    password: 'correct horse battery staple',
    displayName: 'Alice',
    studioSlug: 'downtown-fitness',
    consents: {
      marketing: false,
      analytics: true,
      thirdParty: false,
    },
  };
}

/** Helper: build a NextRequest for the route handler. */
function buildRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
    body: JSON.stringify(body),
  });
}

/** Helper: JSON upstream Response. */
function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/auth/register', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips refreshToken and sets athlya.refresh cookie on upstream 201', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          user: { id: 'u1', email: 'alice@example.com' },
          accessToken: 'access.jwt',
          refreshToken: 'refresh.jwt',
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        },
        201,
      ),
    );

    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['accessToken']).toBe('access.jwt');
    expect(body['accessTokenExpiresIn']).toBe(900);
    expect(body['refreshToken']).toBeUndefined();
    expect(body['refreshTokenExpiresIn']).toBeUndefined();

    const cookie = res.headers.get('set-cookie');
    expect(cookie).not.toBeNull();
    expect(cookie!).toContain('athlya.refresh=refresh.jwt');
    expect(cookie!).toContain('HttpOnly');
    expect(cookie!).toContain('SameSite=Lax');
    expect(cookie!).toContain('Path=/api/auth');
    expect(cookie!).toContain('Max-Age=2592000');
  });

  it('returns 422 Problem Details when email is missing (no upstream call)', async () => {
    const { email: _email, ...missingEmail } = validBody();
    void _email;
    const res = await POST(buildRequest(missingEmail));

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe(422);
    expect(body['code']).toBe('validation_failed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards upstream 422 (password_breached) verbatim without setting a cookie', async () => {
    const upstreamProblem = {
      type: 'about:blank',
      title: 'Password has been compromised',
      status: 422,
      code: 'password_breached',
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamProblem), {
        status: 422,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('password_breached');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('forwards upstream 403 Turnstile failure verbatim', async () => {
    const upstreamProblem = {
      type: 'about:blank',
      title: 'Turnstile check failed',
      status: 403,
      code: 'bot_challenge_failed',
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamProblem), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    const res = await POST(buildRequest(validBody()));

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('bot_challenge_failed');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets Secure cookie attribute when APP_ENV=production (issue #465)', async () => {
    vi.stubEnv('APP_ENV', 'production');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          user: { id: 'u1', email: 'alice@example.com' },
          accessToken: 'access.jwt',
          refreshToken: 'refresh.jwt',
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        },
        201,
      ),
    );
    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));
    expect(res.headers.get('set-cookie')).toContain('Secure');
    vi.unstubAllEnvs();
  });

  it('sets Secure cookie attribute when APP_ENV=staging (issue #465)', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          user: { id: 'u1', email: 'alice@example.com' },
          accessToken: 'access.jwt',
          refreshToken: 'refresh.jwt',
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        },
        201,
      ),
    );
    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));
    expect(res.headers.get('set-cookie')).toContain('Secure');
    vi.unstubAllEnvs();
  });

  it('omits Secure cookie attribute when APP_ENV=development (issue #465)', async () => {
    vi.stubEnv('APP_ENV', 'development');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          user: { id: 'u1', email: 'alice@example.com' },
          accessToken: 'access.jwt',
          refreshToken: 'refresh.jwt',
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        },
        201,
      ),
    );
    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
    vi.unstubAllEnvs();
  });

  it('sets Secure cookie attribute when APP_ENV is unset (fail-closed, issue #465)', async () => {
    vi.stubEnv('APP_ENV', '');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          user: { id: 'u1', email: 'alice@example.com' },
          accessToken: 'access.jwt',
          refreshToken: 'refresh.jwt',
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        },
        201,
      ),
    );
    const res = await POST(buildRequest(validBody(), { 'cf-turnstile-token': 'tts.token' }));
    expect(res.headers.get('set-cookie')).toContain('Secure');
    vi.unstubAllEnvs();
  });

  it('forwards an empty cf-turnstile-token header when the client omits it', async () => {
    // Prime the upstream to return 403 so we can inspect the header
    // the route passed through without having to keep going.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'nope', status: 403 }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    await POST(buildRequest(validBody()));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('cf-turnstile-token')).toBe('');
  });
});
