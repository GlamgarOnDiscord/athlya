/**
 * Tests for the public CSP violation sink (issue #136).
 *
 * Exercises the route through a real `buildApp()` so the `/v1/*`
 * jwtAuth skip + public mount are validated end-to-end, not just the
 * handler in isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CSP_VIOLATION_LOG_MESSAGE,
  CSP_VIOLATION_METRIC,
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

function post(app: ReturnType<typeof buildAppNoDomainRoutes>, body: string, contentType: string) {
  return app.request(
    '/v1/csp-report',
    { method: 'POST', headers: { 'content-type': contentType, 'user-agent': 'test-ua' }, body },
    mockEnv(),
  );
}

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
});
