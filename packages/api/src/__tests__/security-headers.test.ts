/**
 * Unit tests for the security-headers middleware.
 *
 * Exercises:
 *   1. `buildSecurityHeaders()` default output — five headers, verbatim
 *      per {@link DEFAULT_SECURITY_HEADERS}.
 *   2. HSTS directive composition — four combinations of
 *      `includeSubDomains` × `preload`.
 *   3. Custom `hstsMaxAgeSeconds` flows through.
 *   4. `frameOptions: 'SAMEORIGIN'` overrides the default.
 *   5. `extraHeaders` merge — safe additions land; attempts to
 *      overwrite a reserved security header are dropped (default
 *      wins), documented as a stable invariant.
 *   6. `applySecurityHeaders(response, headers)` — returns a new
 *      Response (not the original), with every header set and the
 *      body preserved.
 *   7. `securityHeaders()` middleware — calls `c.header` once per
 *      default header and calls `next` exactly once.
 *
 * Every test uses a fake Hono context (`{ header: vi.fn() }`); no real
 * Hono import so the module stays framework-free.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SECURITY_HEADERS,
  applySecurityHeaders,
  buildSecurityHeaders,
  securityHeaders,
  type SecurityHeadersContext,
} from '../middleware/security-headers.js';

/* ------------------------------------------------------------------ */
/*  buildSecurityHeaders — defaults                                    */
/* ------------------------------------------------------------------ */

describe('buildSecurityHeaders — defaults', () => {
  it('returns the five default headers verbatim when called with no options', () => {
    const headers = buildSecurityHeaders();

    expect(headers).toStrictEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('each default header matches DEFAULT_SECURITY_HEADERS', () => {
    const headers = buildSecurityHeaders();
    for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      expect(headers[key]).toBe(value);
    }
  });

  it('returns a fresh object on every call (no shared mutation)', () => {
    const a = buildSecurityHeaders();
    const b = buildSecurityHeaders();
    expect(a).not.toBe(b);

    a['X-Frame-Options'] = 'SAMEORIGIN';
    expect(b['X-Frame-Options']).toBe('DENY');
  });

  it('DEFAULT_SECURITY_HEADERS is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SECURITY_HEADERS)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  HSTS directive composition                                         */
/* ------------------------------------------------------------------ */

describe('buildSecurityHeaders — HSTS', () => {
  it('honours hstsMaxAgeSeconds override', () => {
    const headers = buildSecurityHeaders({ hstsMaxAgeSeconds: 3_600 });
    expect(headers['Strict-Transport-Security']).toBe('max-age=3600; includeSubDomains; preload');
  });

  it.each([
    {
      includeSubDomains: true,
      preload: true,
      expected: 'max-age=63072000; includeSubDomains; preload',
    },
    {
      includeSubDomains: true,
      preload: false,
      expected: 'max-age=63072000; includeSubDomains',
    },
    {
      includeSubDomains: false,
      preload: true,
      expected: 'max-age=63072000; preload',
    },
    {
      includeSubDomains: false,
      preload: false,
      expected: 'max-age=63072000',
    },
  ])(
    'composes directives correctly (includeSubDomains=$includeSubDomains, preload=$preload)',
    ({ includeSubDomains, preload, expected }) => {
      const headers = buildSecurityHeaders({
        hstsIncludeSubDomains: includeSubDomains,
        hstsPreload: preload,
      });
      expect(headers['Strict-Transport-Security']).toBe(expected);
    },
  );

  it('clamps negative max-age to 0 rather than emitting a malformed header', () => {
    const headers = buildSecurityHeaders({ hstsMaxAgeSeconds: -1 });
    expect(headers['Strict-Transport-Security']).toBe('max-age=0; includeSubDomains; preload');
  });
});

/* ------------------------------------------------------------------ */
/*  Overrides                                                          */
/* ------------------------------------------------------------------ */

describe('buildSecurityHeaders — overrides', () => {
  it('frameOptions: SAMEORIGIN overrides the default DENY', () => {
    const headers = buildSecurityHeaders({ frameOptions: 'SAMEORIGIN' });
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('referrerPolicy override flows through', () => {
    const headers = buildSecurityHeaders({
      referrerPolicy: 'no-referrer',
    });
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('permissionsPolicy override flows through', () => {
    const headers = buildSecurityHeaders({
      permissionsPolicy: 'camera=(self)',
    });
    expect(headers['Permissions-Policy']).toBe('camera=(self)');
  });
});

/* ------------------------------------------------------------------ */
/*  extraHeaders merge invariant                                       */
/* ------------------------------------------------------------------ */

describe('buildSecurityHeaders — extraHeaders', () => {
  it('merges safe additional headers alongside defaults', () => {
    const headers = buildSecurityHeaders({
      extraHeaders: {
        'Content-Security-Policy': "default-src 'self'",
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    });

    expect(headers['Content-Security-Policy']).toBe("default-src 'self'");
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    // Defaults still present.
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it('INVARIANT: extraHeaders cannot overwrite a reserved security header — the default wins', () => {
    const headers = buildSecurityHeaders({
      extraHeaders: {
        // Same key, exact case — must be dropped.
        'X-Frame-Options': 'SAMEORIGIN',
        // Same key, different case — must also be dropped
        // because HTTP header names are case-insensitive.
        'strict-transport-security': 'max-age=0',
        // Same key, mixed case — likewise dropped.
        'referrer-POLICY': 'unsafe-url',
      },
    });

    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(headers['Referrer-Policy']).toBe('strict-origin');
    // The lowercase / mixed-case variants must not have landed as
    // distinct keys either.
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['referrer-POLICY']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  applySecurityHeaders — Response adapter                            */
/* ------------------------------------------------------------------ */

describe('applySecurityHeaders', () => {
  it('returns a NEW Response instance (not the original)', () => {
    const original = new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    const out = applySecurityHeaders(original, buildSecurityHeaders());
    expect(out).not.toBe(original);
  });

  it('sets every header from the map on the returned response', async () => {
    const headers = buildSecurityHeaders();
    const out = applySecurityHeaders(new Response('ok'), headers);

    for (const [key, value] of Object.entries(headers)) {
      expect(out.headers.get(key)).toBe(value);
    }

    // Body survives the clone.
    await expect(out.text()).resolves.toBe('ok');
  });

  it('preserves status and pre-existing non-security headers', async () => {
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'x-trace-id': 't-1',
      },
    });
    const out = applySecurityHeaders(original, buildSecurityHeaders());

    expect(out.status).toBe(201);
    expect(out.headers.get('content-type')).toBe('application/json');
    expect(out.headers.get('x-trace-id')).toBe('t-1');
    expect(out.headers.get('x-frame-options')).toBe('DENY');
    await expect(out.json()).resolves.toEqual({ ok: true });
  });

  it('leaves the original response body readable (clone is used)', async () => {
    const original = new Response('payload');
    applySecurityHeaders(original, buildSecurityHeaders());
    // The original must still be readable because we cloned before
    // consuming — this is the invariant that makes the function
    // side-effect free from the caller's perspective.
    await expect(original.text()).resolves.toBe('payload');
  });
});

/* ------------------------------------------------------------------ */
/*  securityHeaders middleware                                         */
/* ------------------------------------------------------------------ */

describe('securityHeaders middleware', () => {
  function fakeContext(): SecurityHeadersContext & {
    header: ReturnType<typeof vi.fn>;
  } {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return { header: vi.fn() } as unknown as SecurityHeadersContext & {
      header: ReturnType<typeof vi.fn>;
    };
  }

  it('calls c.header once per default header and calls next exactly once', async () => {
    const middleware = securityHeaders();
    const c = fakeContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    const defaultCount = Object.keys(DEFAULT_SECURITY_HEADERS).length;
    expect(c.header).toHaveBeenCalledTimes(defaultCount);
    expect(next).toHaveBeenCalledTimes(1);

    // Every default header was written with its canonical value.
    for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      expect(c.header).toHaveBeenCalledWith(key, value);
    }
  });

  it('forwards overrides to the emitted headers', async () => {
    const middleware = securityHeaders({
      frameOptions: 'SAMEORIGIN',
      hstsMaxAgeSeconds: 3_600,
      hstsIncludeSubDomains: false,
      hstsPreload: false,
    });
    const c = fakeContext();

    await middleware(c, () => Promise.resolve());

    expect(c.header).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
    expect(c.header).toHaveBeenCalledWith('Strict-Transport-Security', 'max-age=3600');
  });

  it('emits headers BEFORE awaiting next (so error responses still carry them)', async () => {
    const callOrder: string[] = [];
    const middleware = securityHeaders();
    const c: SecurityHeadersContext = {
      header: (_k, _v) => callOrder.push('header'),
    };
    const next = (): Promise<void> => {
      callOrder.push('next');
      return Promise.resolve();
    };

    await middleware(c, next);

    const firstNextIndex = callOrder.indexOf('next');
    const lastHeaderIndex = callOrder.lastIndexOf('header');
    expect(firstNextIndex).toBeGreaterThan(lastHeaderIndex);
  });

  it('emits additional extraHeaders but not any that would overwrite a reserved key', async () => {
    const middleware = securityHeaders({
      extraHeaders: {
        'Content-Security-Policy': "default-src 'self'",
        'X-Frame-Options': 'SAMEORIGIN', // must be dropped
      },
    });
    const c = fakeContext();

    await middleware(c, () => Promise.resolve());

    expect(c.header).toHaveBeenCalledWith('Content-Security-Policy', "default-src 'self'");
    // The reserved default still wins.
    expect(c.header).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    // And we never emitted SAMEORIGIN via the merge path.
    const frameCalls = c.header.mock.calls.filter(
      ([k]) => String(k).toLowerCase() === 'x-frame-options',
    );
    expect(frameCalls).toHaveLength(1);
    expect(frameCalls[0]?.[1]).toBe('DENY');
  });
});
