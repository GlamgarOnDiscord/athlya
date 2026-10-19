/**
 * Route handler tests for `POST /api/auth/logout`.
 *
 *  1. With an access token and the refresh cookie, the upstream logout
 *     receives the refresh token so only this session is revoked
 *     (audit finding S2-010), and the cookie is cleared.
 *  2. Without the refresh cookie, the upstream logout is sent with no
 *     body.
 *  3. Without an access token, the upstream is not called; the cookie
 *     is still cleared.
 *  4. An unreachable upstream does not prevent the local logout.
 *
 * @see Requirements 1.5, 2.3.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

function buildRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
  });
}

describe('POST /api/auth/logout', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the refresh cookie so the upstream revokes this session only', async () => {
    const res = await POST(
      buildRequest({ authorization: 'Bearer access.jwt', cookie: 'athlya.refresh=refresh.jwt' }),
    );

    expect(res.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(target).toMatch(/\/v1\/auth\/logout$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer access.jwt');
    expect(init.body).toBe(JSON.stringify({ refreshToken: 'refresh.jwt' }));
    expect(res.headers.get('set-cookie')).toContain('athlya.refresh=;');
  });

  it('sends no body upstream when there is no refresh cookie', async () => {
    const res = await POST(buildRequest({ authorization: 'Bearer access.jwt' }));

    expect(res.status).toBe(204);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('skips the upstream call without an access token and still clears the cookie', async () => {
    const res = await POST(buildRequest({ cookie: 'athlya.refresh=refresh.jwt' }));

    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain('athlya.refresh=;');
  });

  it('clears the cookie even when the upstream is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await POST(
      buildRequest({ authorization: 'Bearer access.jwt', cookie: 'athlya.refresh=refresh.jwt' }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('athlya.refresh=;');
  });
});
