/**
 * Unit tests for the framework-free tenant resolver.
 *
 * Exercises the algorithm in {@link resolveTenant}:
 *   • Subdomain resolution (happy path, mixed case, port suffix).
 *   • Reserved subdomain rejection.
 *   • Apex / IP literal / localhost short-circuit.
 *   • Path-based resolution with prefix stripping.
 *   • Invalid slug shapes (uppercase, leading hyphen, too short).
 *   • Custom `apexHost` and `reservedSubdomains` overrides.
 *
 * Validates: Requirements 13.1, 13.5.
 */

import { describe, expect, it } from 'vitest';

import { RESERVED_SUBDOMAINS, SLUG_REGEX, resolveTenant } from '../middleware/tenant-resolver.js';

/* ------------------------------------------------------------------ */
/*  Subdomain resolution                                               */
/* ------------------------------------------------------------------ */

describe('resolveTenant — subdomain source', () => {
  it('resolves `acme.athlya.app` to slug `acme`', () => {
    expect(resolveTenant({ host: 'acme.athlya.app', path: '/' })).toEqual({
      source: 'subdomain',
      slug: 'acme',
    });
  });

  it('lowercases a mixed-case host before matching', () => {
    expect(resolveTenant({ host: 'ACME.Athlya.App', path: '/' })).toEqual({
      source: 'subdomain',
      slug: 'acme',
    });
  });

  it('strips an explicit port suffix before matching', () => {
    expect(resolveTenant({ host: 'acme.athlya.app:8080', path: '/' })).toEqual({
      source: 'subdomain',
      slug: 'acme',
    });
  });

  it('ignores the request path when a valid subdomain matches', () => {
    // The subdomain wins; the path is forwarded as-is by the
    // caller, so the resolver should not touch it.
    expect(
      resolveTenant({
        host: 'acme.athlya.app',
        path: '/v1/classes',
      }),
    ).toEqual({ source: 'subdomain', slug: 'acme' });
  });
});

/* ------------------------------------------------------------------ */
/*  Reserved subdomains                                                */
/* ------------------------------------------------------------------ */

describe('resolveTenant — reserved subdomains', () => {
  it('returns none for `www.athlya.app`', () => {
    expect(resolveTenant({ host: 'www.athlya.app', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for `api.athlya.app`', () => {
    expect(resolveTenant({ host: 'api.athlya.app', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it.each(RESERVED_SUBDOMAINS)('returns none for every default reserved subdomain — %s', (sub) => {
    expect(resolveTenant({ host: `${sub}.athlya.app`, path: '/' })).toEqual({ source: 'none' });
  });
});

/* ------------------------------------------------------------------ */
/*  Apex and dev hosts                                                 */
/* ------------------------------------------------------------------ */

describe('resolveTenant — apex and dev hosts', () => {
  it('returns none for the apex host itself', () => {
    expect(resolveTenant({ host: 'athlya.app', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for `localhost`', () => {
    expect(resolveTenant({ host: 'localhost', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for a bare IPv4 literal', () => {
    expect(resolveTenant({ host: '127.0.0.1', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for a private IPv4 literal', () => {
    expect(resolveTenant({ host: '192.168.1.10', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for a bracketed IPv6 literal', () => {
    expect(resolveTenant({ host: '[::1]', path: '/' })).toEqual({
      source: 'none',
    });
  });

  it('returns none for a bracketed IPv6 literal with port', () => {
    expect(resolveTenant({ host: '[::1]:8080', path: '/' })).toEqual({
      source: 'none',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Path-based resolution                                              */
/* ------------------------------------------------------------------ */

describe('resolveTenant — path source', () => {
  it('strips the `/s/{slug}` prefix from a deeper path', () => {
    expect(
      resolveTenant({
        host: 'athlya.app',
        path: '/s/acme/v1/classes',
      }),
    ).toEqual({
      source: 'path',
      slug: 'acme',
      pathWithoutPrefix: '/v1/classes',
    });
  });

  it('returns `/` when the path is exactly `/s/{slug}` (no trailing slash)', () => {
    expect(resolveTenant({ host: 'athlya.app', path: '/s/acme' })).toEqual({
      source: 'path',
      slug: 'acme',
      pathWithoutPrefix: '/',
    });
  });

  it('returns `/` when the path is `/s/{slug}/` (trailing slash only)', () => {
    expect(resolveTenant({ host: 'athlya.app', path: '/s/acme/' })).toEqual({
      source: 'path',
      slug: 'acme',
      pathWithoutPrefix: '/',
    });
  });

  it('rejects an uppercase slug in the path (case-sensitive per RFC 3986)', () => {
    expect(
      resolveTenant({
        host: 'athlya.app',
        path: '/s/ACME/v1/classes',
      }),
    ).toEqual({ source: 'none' });
  });

  it('rejects a slug that starts with a hyphen', () => {
    expect(
      resolveTenant({
        host: 'athlya.app',
        path: '/s/-acme/v1/classes',
      }),
    ).toEqual({ source: 'none' });
  });

  it('rejects a slug that is too short (one character)', () => {
    expect(resolveTenant({ host: 'athlya.app', path: '/s/a/v1/classes' })).toEqual({
      source: 'none',
    });
  });

  it('resolves via path even when the host is localhost (dev)', () => {
    expect(
      resolveTenant({
        host: 'localhost',
        path: '/s/acme/v1/classes',
      }),
    ).toEqual({
      source: 'path',
      slug: 'acme',
      pathWithoutPrefix: '/v1/classes',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Options — custom apexHost                                          */
/* ------------------------------------------------------------------ */

describe('resolveTenant — custom apexHost', () => {
  it('uses the provided apexHost for the subdomain suffix match', () => {
    expect(
      resolveTenant({ host: 'acme.pilates.test', path: '/' }, { apexHost: 'pilates.test' }),
    ).toEqual({ source: 'subdomain', slug: 'acme' });
  });

  it('does not match the default apex when a custom apexHost is set', () => {
    expect(
      resolveTenant({ host: 'acme.athlya.app', path: '/' }, { apexHost: 'pilates.test' }),
    ).toEqual({ source: 'none' });
  });

  it('treats the custom apex host itself as none', () => {
    expect(
      resolveTenant({ host: 'pilates.test', path: '/' }, { apexHost: 'pilates.test' }),
    ).toEqual({ source: 'none' });
  });
});

/* ------------------------------------------------------------------ */
/*  Options — custom reservedSubdomains                                */
/* ------------------------------------------------------------------ */

describe('resolveTenant — custom reservedSubdomains', () => {
  it('extends the default reserved list rather than replacing it', () => {
    // `beta` is added; the default `www` must still be rejected.
    expect(
      resolveTenant({ host: 'beta.athlya.app', path: '/' }, { reservedSubdomains: ['beta'] }),
    ).toEqual({ source: 'none' });

    expect(
      resolveTenant({ host: 'www.athlya.app', path: '/' }, { reservedSubdomains: ['beta'] }),
    ).toEqual({ source: 'none' });
  });

  it('does not affect slugs that are not reserved', () => {
    expect(
      resolveTenant({ host: 'acme.athlya.app', path: '/' }, { reservedSubdomains: ['beta'] }),
    ).toEqual({ source: 'subdomain', slug: 'acme' });
  });
});

/* ------------------------------------------------------------------ */
/*  SLUG_REGEX sanity                                                  */
/* ------------------------------------------------------------------ */

describe('SLUG_REGEX', () => {
  it.each(['acme', 'abc', 'acme-studio', 'a-b', 'a1b2', '123', 'x'.repeat(63)])(
    'accepts %s',
    (slug) => {
      expect(SLUG_REGEX.test(slug)).toBe(true);
    },
  );

  it.each([
    '', // empty
    'ab', // too short
    '-acme', // leading hyphen
    'acme-', // trailing hyphen
    'ACME', // uppercase
    'acme_studio', // underscore
    'acme.studio', // dot
    'x'.repeat(64), // too long
  ])('rejects %s', (slug) => {
    expect(SLUG_REGEX.test(slug)).toBe(false);
  });
});
