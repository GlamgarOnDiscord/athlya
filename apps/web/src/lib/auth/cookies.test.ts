/**
 * Unit tests for the refresh-cookie helpers.
 *
 * Six assertions cover the security-critical flags (HttpOnly, Secure,
 * SameSite, Path, Max-Age) plus the dev-mode carve-out that drops
 * `Secure` for `http://localhost`, and the clear cookie's `Max-Age=0`.
 *
 * Sprint 1 / Slice 1.2 — refresh cookie is now scoped to
 * `Path=/api/auth` (Finding S4-006), so the path assertion below
 * pins the new value.
 *
 * @see Requirements 2.3, 25.2.
 */
import { describe, expect, it } from 'vitest';

import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  buildClearRefreshCookie,
  buildRefreshCookie,
} from './cookies';

describe('buildRefreshCookie', () => {
  it('emits HttpOnly', () => {
    const v = buildRefreshCookie({ token: 't', maxAgeSec: 3600 });
    expect(v).toContain('HttpOnly');
  });

  it('emits Secure in production', () => {
    const v = buildRefreshCookie({ token: 't', maxAgeSec: 3600, isProduction: true });
    expect(v).toContain('Secure');
  });

  it('drops Secure when isProduction=false (localhost dev)', () => {
    const v = buildRefreshCookie({ token: 't', maxAgeSec: 3600, isProduction: false });
    expect(v).not.toContain('Secure');
  });

  it('emits SameSite=Lax', () => {
    const v = buildRefreshCookie({ token: 't', maxAgeSec: 3600 });
    expect(v).toContain('SameSite=Lax');
  });

  it('emits Path=/api/auth and Max-Age with the expected value', () => {
    const v = buildRefreshCookie({ token: 'abc', maxAgeSec: 2_592_000 });
    expect(REFRESH_COOKIE_PATH).toBe('/api/auth');
    expect(v).toContain('Path=/api/auth');
    // Guard: the previous "Path=/" attribute would let the cookie
    // ship on every Next.js route, defeating S4-006. Assert the
    // narrower scope is exact, not a prefix match.
    expect(v).not.toMatch(/Path=\/(?:[;,\s]|$)/u);
    expect(v).toContain('Max-Age=2592000');
    expect(v.startsWith(`${REFRESH_COOKIE_NAME}=abc`)).toBe(true);
  });
});

describe('buildClearRefreshCookie', () => {
  it('emits Max-Age=0, HttpOnly, SameSite=Lax and Path=/api/auth', () => {
    const v = buildClearRefreshCookie(true);
    expect(v).toContain('Max-Age=0');
    expect(v).toContain('HttpOnly');
    expect(v).toContain('SameSite=Lax');
    expect(v).toContain('Secure');
    expect(v).toContain('Path=/api/auth');
    expect(v.startsWith(`${REFRESH_COOKIE_NAME}=`)).toBe(true);
  });
});
