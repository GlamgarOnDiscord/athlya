import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { assertSameOrigin } from './auth/same-origin';
import { buildClearRefreshCookie, buildRefreshCookie, REFRESH_COOKIE_NAME } from './auth/cookies';
import { buildReportToHeader, generateCsp } from './csp';
import { negotiateLocale } from './i18n/negotiate';
import { generateNonce } from './nonce';

/**
 * Studio security baseline (issue #422): the CSP, CSRF origin check and
 * refresh cookie guard the admin UI; a regression here must fail CI.
 */

describe('generateCsp', () => {
  it('pins scripts to the nonce and forbids framing and plugins', () => {
    const csp = generateCsp({ nonce: 'abc', apiUrl: 'https://api.athlya.test' });
    expect(csp).toContain(`script-src 'self' 'nonce-abc' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-abc'`);
    expect(csp).toContain(`frame-ancestors 'none'`);
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain(`connect-src 'self' https://api.athlya.test`);
    expect(csp).not.toContain('unsafe-eval');
  });

  it('only relaxes eval in dev and refuses an empty nonce', () => {
    expect(generateCsp({ nonce: 'n', dev: true })).toContain(`'unsafe-eval'`);
    expect(() => generateCsp({ nonce: '' })).toThrow(TypeError);
  });

  it('adds reporting directives only with a report URI', () => {
    expect(generateCsp({ nonce: 'n' })).not.toContain('report-uri');
    expect(generateCsp({ nonce: 'n', reportUri: 'https://r.test/csp' })).toContain(
      'report-uri https://r.test/csp',
    );
    expect(buildReportToHeader(undefined)).toBeUndefined();
    expect(JSON.parse(buildReportToHeader('https://r.test/csp')!)).toMatchObject({
      group: 'athlya-csp',
    });
  });
});

describe('assertSameOrigin', () => {
  const req = (headers: Record<string, string>) =>
    new NextRequest('https://studio.athlya.test/api/auth/login', { method: 'POST', headers });

  it('accepts a same-origin request', () => {
    expect(assertSameOrigin(req({ origin: 'https://studio.athlya.test' }))).toBeNull();
  });

  it.each([
    [{}],
    [{ origin: 'https://evil.test' }],
    [{ origin: 'https://studio.athlya.test', referer: 'https://evil.test/x' }],
    [{ origin: 'https://studio.athlya.test', referer: 'not a url' }],
  ])('rejects %j with 403 cross_site_request', async (headers) => {
    const res = assertSameOrigin(req(headers as Record<string, string>));
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as { code: string }).code).toBe('cross_site_request');
  });
});

describe('refresh cookie', () => {
  it('is HttpOnly, path-scoped and Secure in production', () => {
    const cookie = buildRefreshCookie({ token: 't', maxAgeSec: 60.9 });
    expect(cookie).toBe(
      `${REFRESH_COOKIE_NAME}=t; Path=/api/auth; Max-Age=60; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(buildRefreshCookie({ token: 't', maxAgeSec: 1, isProduction: false })).not.toContain(
      'Secure',
    );
    expect(buildClearRefreshCookie()).toContain('Max-Age=0');
  });

  it('rejects a negative lifetime', () => {
    expect(() => buildRefreshCookie({ token: 't', maxAgeSec: -1 })).toThrow(TypeError);
  });
});

describe('generateNonce / negotiateLocale', () => {
  it('produces unique base64url nonces of 128 bits', () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(generateNonce()).not.toBe(a);
  });

  it('picks the best supported locale by quality', () => {
    expect(negotiateLocale('en-US;q=0.5, fr;q=0.9', ['fr', 'en'] as const, 'fr')).toBe('fr');
    expect(negotiateLocale('de, en;q=0.8', ['fr', 'en'] as const, 'fr')).toBe('en');
    expect(negotiateLocale(null, ['fr', 'en'] as const, 'fr')).toBe('fr');
  });
});
