/**
 * Tests for the public CSP violation sink (issue #136, #519).
 *
 * Exercises the route through a real `buildApp()` so the `/v1/*`
 * jwtAuth skip + public mount are validated end-to-end, not just the
 * handler in isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CSP_VIOLATION_LOG_MESSAGE,
  CSP_VIOLATION_METRIC,
  sanitizeUrl,
  sanitizeUserAgent,
  sanitizeString,
} from '../routes/csp-report.js';

import { buildAppNoDomainRoutes } from './helpers/test-app.js';

import type { AthlyaBindings } from '../types.js';

function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_NOTIFICATIONS_QUEUE: {
      send: vi.fn(),
    } as unknown as AthlyaBindings['EVENTS_NOTIFICATIONS_QUEUE'],
    EVENTS_RGPD_QUEUE: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_RGPD_QUEUE'],
    EVENTS_DLQ: { send: vi.fn() } as unknown as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: '',
    REDIS_URL: '',
    REDIS_TOKEN: '',
    JWT_JWKS_URL: '',
    VERSION: 'test',
    ...overrides,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function post(
  app: ReturnType<typeof buildAppNoDomainRoutes>,
  body: string,
  contentType: string,
  ua = 'test-ua',
) {
  return app.request(
    '/v1/csp-report',
    { method: 'POST', headers: { 'content-type': contentType, 'user-agent': ua }, body },
    mockEnv(),
  );
}

// ── sanitizeUrl unit tests ──────────────────────────────────────────────────

describe('sanitizeUrl', () => {
  it('passes a clean https URL unchanged', () => {
    expect(sanitizeUrl('https://app.athlya.app/login')).toBe('https://app.athlya.app/login');
  });

  it('strips query string', () => {
    expect(sanitizeUrl('https://app.athlya.app/confirm?token=secret123')).toBe(
      'https://app.athlya.app/confirm',
    );
  });

  it('strips fragment', () => {
    expect(sanitizeUrl('https://app.athlya.app/page#section')).toBe('https://app.athlya.app/page');
  });

  it('strips embedded URL credentials', () => {
    expect(sanitizeUrl('https://user:pass@app.athlya.app/path')).toBe(
      'https://app.athlya.app/path',
    );
  });

  it('redacts /reset-password/<token> path segment', () => {
    expect(sanitizeUrl('https://app.athlya.app/reset-password/abc123secret')).toBe(
      'https://app.athlya.app/reset-password/:redacted',
    );
  });

  it('redacts /confirm-email/<token> path segment', () => {
    expect(sanitizeUrl('https://app.athlya.app/confirm-email/tok-xyz789')).toBe(
      'https://app.athlya.app/confirm-email/:redacted',
    );
  });

  it('redacts /invite/<token> path segment', () => {
    expect(sanitizeUrl('https://app.athlya.app/invite/some-invite-token')).toBe(
      'https://app.athlya.app/invite/:redacted',
    );
  });

  it('returns null for non-http schemes', () => {
    expect(sanitizeUrl('data:text/html,<h1>xss</h1>')).toBeNull();
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('blob:https://app.athlya.app/abc')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(sanitizeUrl('not-a-url')).toBeNull();
    expect(sanitizeUrl('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(sanitizeUrl(null)).toBeNull();
  });

  it('truncates to 2048 characters', () => {
    const long = 'https://app.athlya.app/' + 'a'.repeat(3000);
    const result = sanitizeUrl(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2048);
  });
});

// ── sanitizeUserAgent unit tests ────────────────────────────────────────────

describe('sanitizeUserAgent', () => {
  it('returns null for null', () => {
    expect(sanitizeUserAgent(null)).toBeNull();
  });

  it('strips control characters', () => {
    expect(sanitizeUserAgent('Mozilla\x00/5.0\x1f(Windows)')).toBe('Mozilla/5.0(Windows)');
  });

  it('truncates to 512 characters', () => {
    const long = 'A'.repeat(600);
    expect(sanitizeUserAgent(long)!.length).toBe(512);
  });
});

// ── sanitizeString unit tests ───────────────────────────────────────────────

describe('sanitizeString', () => {
  it('strips control characters', () => {
    expect(sanitizeString("script-src\x00'self'")).toBe("script-src'self'");
  });

  it('truncates to default 256 characters', () => {
    expect(sanitizeString('a'.repeat(300))!.length).toBe(256);
  });

  it('returns null for null', () => {
    expect(sanitizeString(null)).toBeNull();
  });
});

// ── Route integration tests ─────────────────────────────────────────────────

describe('POST /v1/csp-report', () => {
  it('accepts the legacy report-uri shape unauthenticated and logs the violation', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify({
      'csp-report': {
        'violated-directive': "script-src 'self'",
        'blocked-uri': 'https://evil.example.com/x.js',
        'document-uri': 'https://app.athlya.app/login',
        disposition: 'enforce',
      },
    });

    const res = await post(app, body, 'application/csp-report');

    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      CSP_VIOLATION_LOG_MESSAGE,
      expect.objectContaining({
        metric: CSP_VIOLATION_METRIC,
        effectiveDirective: "script-src 'self'",
        blockedUri: 'https://evil.example.com/x.js',
        documentUri: 'https://app.athlya.app/login',
      }),
    );
  });

  it('accepts the Reporting API (report-to) batched array shape', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify([
      {
        type: 'csp-violation',
        url: 'https://app.athlya.app/dashboard',
        body: {
          effectiveDirective: 'img-src',
          blockedURL: 'https://tracker.example.com/p.gif',
          disposition: 'report',
        },
      },
    ]);

    const res = await post(app, body, 'application/reports+json');

    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      CSP_VIOLATION_LOG_MESSAGE,
      expect.objectContaining({
        effectiveDirective: 'img-src',
        blockedUri: 'https://tracker.example.com/p.gif',
        documentUri: 'https://app.athlya.app/dashboard',
      }),
    );
  });

  it('returns 204 and a parse-error metric on a malformed body (never errors to the browser)', async () => {
    const app = buildAppNoDomainRoutes();

    const res = await post(app, 'not-json{', 'application/csp-report');

    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      'csp.report_parse_error',
      expect.objectContaining({ metric: 'csp_report_parse_error_total' }),
    );
  });

  it('ignores entries with no recognisable CSP fields', async () => {
    const app = buildAppNoDomainRoutes();

    const res = await post(app, JSON.stringify({ foo: 'bar' }), 'application/json');

    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalledWith(CSP_VIOLATION_LOG_MESSAGE, expect.anything());
  });

  it('caps the number of reports processed per request', async () => {
    const app = buildAppNoDomainRoutes();
    const many = Array.from({ length: 50 }, (_, i) => ({
      body: { effectiveDirective: 'script-src', blockedURL: `https://e/${i}.js` },
    }));

    const res = await post(app, JSON.stringify(many), 'application/reports+json');

    expect(res.status).toBe(204);
    const violationCalls = warn.mock.calls.filter(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    );
    expect(violationCalls.length).toBe(20);
  });

  it('redacts the bearer token from a /reset-password/<token> documentURL', async () => {
    const app = buildAppNoDomainRoutes();
    const secret = 'super-secret-reset-token-abc123';
    const body = JSON.stringify({
      'csp-report': {
        'violated-directive': "script-src 'self'",
        'blocked-uri': 'https://cdn.example.com/x.js',
        'document-uri': `https://app.athlya.app/reset-password/${secret}`,
      },
    });

    const res = await post(app, body, 'application/csp-report');

    expect(res.status).toBe(204);
    const loggedArgs = warn.mock.calls.find(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    )?.[1] as Record<string, unknown> | undefined;
    expect(loggedArgs?.documentUri).toBe('https://app.athlya.app/reset-password/:redacted');
    expect(JSON.stringify(loggedArgs)).not.toContain(secret);
  });

  it('strips query-string credentials from documentURL before logging', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify([
      {
        url: 'https://app.athlya.app/confirm?token=my-secret-token&ref=email',
        body: { effectiveDirective: 'img-src', blockedURL: 'https://cdn.example.com/img.png' },
      },
    ]);

    const res = await post(app, body, 'application/reports+json');

    expect(res.status).toBe(204);
    const loggedArgs = warn.mock.calls.find(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    )?.[1] as Record<string, unknown> | undefined;
    expect(loggedArgs?.documentUri).toBe('https://app.athlya.app/confirm');
    expect(JSON.stringify(loggedArgs)).not.toContain('my-secret-token');
  });

  it('drops blockedURL with a non-http scheme (data:/javascript: injection)', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify({
      'csp-report': {
        'violated-directive': "script-src 'self'",
        'blocked-uri': "javascript:alert('xss')",
        'document-uri': 'https://app.athlya.app/login',
      },
    });

    const res = await post(app, body, 'application/csp-report');

    expect(res.status).toBe(204);
    const loggedArgs = warn.mock.calls.find(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    )?.[1] as Record<string, unknown> | undefined;
    expect(loggedArgs?.blockedUri).toBeNull();
  });

  it('strips control characters from directive field', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify({
      'csp-report': {
        'violated-directive': "script-src\x00'self'",
        'blocked-uri': 'https://cdn.example.com/x.js',
        'document-uri': 'https://app.athlya.app/page',
      },
    });

    const res = await post(app, body, 'application/csp-report');

    expect(res.status).toBe(204);
    const loggedArgs = warn.mock.calls.find(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    )?.[1] as Record<string, unknown> | undefined;
    expect(loggedArgs?.effectiveDirective).not.toContain('\x00');
  });

  it('truncates an oversized User-Agent header before logging', async () => {
    const app = buildAppNoDomainRoutes();
    const body = JSON.stringify({
      'csp-report': {
        'violated-directive': "script-src 'self'",
        'document-uri': 'https://app.athlya.app/page',
      },
    });
    const longUa = 'Mozilla/5.0 ' + 'A'.repeat(600);

    const res = await post(app, body, 'application/csp-report', longUa);

    expect(res.status).toBe(204);
    const loggedArgs = warn.mock.calls.find(
      (call: unknown[]) => call[0] === CSP_VIOLATION_LOG_MESSAGE,
    )?.[1] as Record<string, unknown> | undefined;
    const ua = loggedArgs?.userAgent as string | null;
    expect((ua ?? '').length).toBeLessThanOrEqual(512);
  });
});
