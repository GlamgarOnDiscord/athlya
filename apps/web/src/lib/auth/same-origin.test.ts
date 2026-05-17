/**
 * Unit tests for `assertSameOrigin` — Sprint-3 Slice 3.1
 * (Vague 31, audit findings S4-005 + S6-005).
 *
 * The helper guards `/api/auth/*` Next.js route handlers against
 * cross-site requests that the `SameSite=Lax` cookie attribute alone
 * cannot stop (rogue subdomain, compromised tenant page, etc.).
 *
 * Coverage:
 *   • Same-origin POST (browser-initiated) → null (allow).
 *   • Cross-origin Origin header → 403 cross_site_request.
 *   • Missing Origin → 403 cross_site_request (modern browsers
 *     always attach Origin on POST/PATCH/DELETE).
 *   • Mismatching Referer + matching Origin → 403 (defence in
 *     depth, MITM proxy fingerprint).
 *   • Malformed Referer + matching Origin → 403.
 *
 * @see apps/web/src/lib/auth/same-origin.ts
 */

import { describe, expect, it } from 'vitest';

import { assertSameOrigin } from './same-origin';

import type { NextRequest } from 'next/server';

/**
 * Build a minimal `NextRequest` shape that satisfies what
 * `assertSameOrigin` reads (`nextUrl.origin`, `headers.get`).
 * Casting is type-only — runtime values are sufficient for the
 * helper.
 */
function makeRequest(opts: {
  appOrigin: string;
  origin?: string | null;
  referer?: string | null;
}): NextRequest {
  const headers = new Headers();
  if (opts.origin !== null && opts.origin !== undefined) {
    headers.set('origin', opts.origin);
  }
  if (opts.referer !== null && opts.referer !== undefined) {
    headers.set('referer', opts.referer);
  }
  return {
    nextUrl: { origin: opts.appOrigin },
    headers,
  } as unknown as NextRequest;
}

describe('assertSameOrigin (Sprint-3 SP3.1, S4-005 + S6-005)', () => {
  it('allows a same-origin POST (Origin matches the app)', () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://app.athlya.test',
      }),
    );
    expect(denied).toBeNull();
  });

  it('denies a cross-origin POST (Origin header present but mismatched)', async () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://evil.example.com',
      }),
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
    const body = (await denied!.json()) as { code: string };
    expect(body.code).toBe('cross_site_request');
  });

  it('denies a request with no Origin header (CSRF tell on a state-changing route)', async () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: null,
      }),
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  it('denies when Referer disagrees with Origin (MITM / proxy fingerprint)', async () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://app.athlya.test',
        referer: 'https://evil.example.com/some/page',
      }),
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  it('denies when Referer is malformed (defensive)', async () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://app.athlya.test',
        referer: 'not a url',
      }),
    );
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  it('allows when Referer agrees with Origin and matches the app', () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://app.athlya.test',
        referer: 'https://app.athlya.test/login',
      }),
    );
    expect(denied).toBeNull();
  });

  it('allows when Origin matches and Referer is absent (mobile webview / privacy-mode browsers)', () => {
    const denied = assertSameOrigin(
      makeRequest({
        appOrigin: 'https://app.athlya.test',
        origin: 'https://app.athlya.test',
        referer: null,
      }),
    );
    expect(denied).toBeNull();
  });
});
