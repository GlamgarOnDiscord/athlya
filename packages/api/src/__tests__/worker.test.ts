/**
 * Unit tests for the Hono gateway skeleton (task 8.1).
 *
 * Scope — wiring-level only:
 *   • `/health` returns the documented envelope and echoes the
 *     trace id from the context.
 *   • A `traceparent` header is parsed per W3C and the extracted
 *     32-hex trace id is echoed back; missing / malformed headers
 *     fall back to a fresh UUID v4.
 *   • Unknown paths surface RFC 9457 Problem Details.
 *   • Thrown handlers surface Problem Details 500 and log at
 *     `error` level exactly once.
 *   • Security headers are present on BOTH success and error
 *     responses (task 8.8 owns the exhaustive coverage; this smoke
 *     test guards the wiring).
 *   • The default Worker export ships a `scheduled` function — the
 *     real drain semantics are covered in `drain-worker.test.ts`.
 *
 * Tests build isolated apps via {@link buildApp} rather than the
 * singleton `app` export so each test starts with a fresh middleware
 * chain — Hono's middleware stack is instance-scoped, so this
 * avoids cross-test bleed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@athlya/db', () => ({
  pingDbHttp: vi.fn().mockResolvedValue(undefined),
  pingDb: vi.fn().mockResolvedValue(undefined),
}));

import workerDefault, { buildApp } from '../worker.js';

import type { AthlyaBindings } from '../types.js';
import type { MockInstance } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Fresh minimal Bindings; `EVENTS_QUEUE.send` is a vi.fn() spy. */
function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  const base: AthlyaBindings = {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: {
      // Minimum shape the gateway consumes — the full Queue
      // interface exposes `sendBatch` too, but 8.1 does not use
      // it and we keep the fake tight.
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_NOTIFICATIONS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_NOTIFICATIONS_QUEUE'],
    EVENTS_RGPD_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_RGPD_QUEUE'],
    EVENTS_DLQ: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: '',
    REDIS_URL: '',
    REDIS_TOKEN: '',
    JWT_JWKS_URL: '',
    VERSION: 'test',
  };
  return { ...base, ...overrides };
}

/**
 * Regex matching either a 32-hex W3C trace id (no dashes — the
 * `traceparent` encoding) or a 36-char UUID v4 (with dashes — the
 * random-id fallback).
 */
const TRACE_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/**
 * Walk a vitest `console` spy and return the first logged JSON line
 * whose parsed `msg` equals `msg`. Returns `undefined` when no such
 * line was emitted so tests can assert presence / absence with the
 * same helper.
 *
 * Typed defensively: `spy.mock.calls` is `unknown[][]` under
 * typescript-eslint's strict mode, so we narrow explicitly before
 * parsing.
 */
function findLogLine(spy: MockInstance, msg: string): string | undefined {
  for (const call of spy.mock.calls) {
    const raw: unknown = (call as unknown[])[0];
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw) as { msg?: unknown };
      if (parsed.msg === msg) return raw;
    } catch {
      // Not JSON — skip.
    }
  }
  return undefined;
}

/** Count matching lines using the same parse logic as {@link findLogLine}. */
function countLogLines(spy: MockInstance, msg: string): number {
  let count = 0;
  for (const call of spy.mock.calls) {
    const raw: unknown = (call as unknown[])[0];
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw) as { msg?: unknown };
      if (parsed.msg === msg) count += 1;
    } catch {
      // Not JSON — skip.
    }
  }
  return count;
}

/* ------------------------------------------------------------------ */
/*  Console silencing                                                  */
/* ------------------------------------------------------------------ */

let logSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
  // The logging middleware writes one JSON line per request; silence
  // it so the test output stays readable. We still assert on the
  // spies below when we care about log calls.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  /health                                                            */
/* ------------------------------------------------------------------ */

describe('GET /health', () => {
  it('returns 200 with the documented envelope', async () => {
    const app = buildApp();
    const res = await app.request('/health', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(200);
    const body = await res.json<{
      status: string;
      environment: string;
      traceId: string;
      version: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('dev');
    expect(body.version).toBe('test');
    expect(body.traceId).toMatch(TRACE_ID_RE);
  });

  it('echoes the 32-hex trace id from a valid traceparent header', async () => {
    const app = buildApp();
    const traceId = 'abcdef0123456789abcdef0123456789';
    const parentId = '0123456789abcdef';
    const traceparent = `00-${traceId}-${parentId}-01`;

    const res = await app.request(
      '/health',
      { method: 'GET', headers: { traceparent } },
      mockEnv(),
    );

    const body = await res.json<{ traceId: string }>();
    expect(body.traceId).toBe(traceId);
    expect(res.headers.get('x-trace-id')).toBe(traceId);
  });

  it('falls back to a generated id when traceparent is malformed', async () => {
    const app = buildApp();
    const res = await app.request(
      '/health',
      { method: 'GET', headers: { traceparent: 'not-a-real-header' } },
      mockEnv(),
    );

    const body = await res.json<{ traceId: string }>();
    // A UUID v4 (36 chars, four dashes) — the 32-hex path is
    // only taken for valid traceparent values.
    expect(body.traceId).toMatch(TRACE_ID_RE);
    expect(body.traceId).toContain('-');
  });

  it('emits security headers on the success response', async () => {
    const app = buildApp();
    const res = await app.request('/health', { method: 'GET' }, mockEnv());

    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('logs a structured `served` line with method, path, status, durationMs, traceId', async () => {
    const app = buildApp();
    await app.request('/health', { method: 'GET' }, mockEnv());

    // The middleware chain emits the tracing scaffolding line
    // before the handler runs (none today — that is task 8.6)
    // plus one `served` line after the response is ready.
    const servedLine = findLogLine(logSpy, 'served');
    expect(servedLine).toBeDefined();

    const payload = JSON.parse(servedLine!) as {
      method: string;
      path: string;
      status: number;
      durationMs: number;
      traceId: string;
      level: string;
    };
    expect(payload.method).toBe('GET');
    expect(payload.path).toBe('/health');
    expect(payload.status).toBe(200);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.traceId).toMatch(TRACE_ID_RE);
    expect(payload.level).toBe('info');
  });
});

/* ------------------------------------------------------------------ */
/*  404 Problem Details                                                */
/* ------------------------------------------------------------------ */

describe('404 handler', () => {
  it('returns Problem Details envelope on unknown paths', async () => {
    const app = buildApp();
    const res = await app.request('/this-route-does-not-exist', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      traceId: string;
    }>();
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    });
    expect(body.traceId).toMatch(TRACE_ID_RE);
  });
});

/* ------------------------------------------------------------------ */
/*  500 Problem Details                                                */
/* ------------------------------------------------------------------ */

describe('error handler', () => {
  it('returns Problem Details 500 and logs at error level when a handler throws', async () => {
    const app = buildApp();
    // Wire a test-only route that throws to exercise `onError`
    // without leaking a production surface.
    app.get('/__boom', () => {
      throw new Error('intentional test failure');
    });

    const res = await app.request('/__boom', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      traceId: string;
    }>();
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
    });
    expect(body.traceId).toMatch(TRACE_ID_RE);

    // Exactly one `unhandled error` line at error level. The
    // `unhandled error` msg is how on-call grep filters these.
    expect(countLogLines(errorSpy, 'unhandled error')).toBe(1);
  });

  it('keeps security headers on the 500 response', async () => {
    const app = buildApp();
    app.get('/__boom', () => {
      throw new Error('boom');
    });

    const res = await app.request('/__boom', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(500);
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('does not leak the thrown error message to the response body', async () => {
    const app = buildApp();
    const secret = 'db-password=hunter2'; // gitleaks:allow
    app.get('/__boom', () => {
      throw new Error(secret);
    });

    const res = await app.request('/__boom', { method: 'GET' }, mockEnv());
    const text = await res.text();
    expect(text).not.toContain(secret);
  });

  it('emits a Problem Details body carrying the 4-field minimum + traceId', async () => {
    // Task 8.5: the centralised mapper in
    // `middleware/problem-details.ts` owns every thrown error,
    // and a generic `Error` must surface the minimal RFC 9457
    // envelope (`type`, `title`, `status`) plus the gateway's
    // `traceId`. No `detail`, no `code`, no `errors` for the
    // fallback branch — that is the secret-leak guard at the
    // type level.
    const app = buildApp();
    app.get('/__boom', () => {
      throw new Error('internal failure');
    });

    const res = await app.request('/__boom', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      traceId: string;
      detail?: unknown;
      code?: unknown;
      errors?: unknown;
    }>();

    // 4-field minimum is present.
    expect(body.type).toBe('about:blank');
    expect(body.title).toBe('Internal Server Error');
    expect(body.status).toBe(500);
    expect(body.traceId).toMatch(TRACE_ID_RE);

    // And no extra fields slip through on the fallback branch.
    expect(body.detail).toBeUndefined();
    expect(body.code).toBeUndefined();
    expect(body.errors).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Worker default export                                              */
/* ------------------------------------------------------------------ */

describe('default Worker export', () => {
  it('exposes a fetch function', () => {
    expect(typeof workerDefault.fetch).toBe('function');
  });

  it('exposes a scheduled function', () => {
    // The real drain semantics are covered in drain-worker.test.ts;
    // this smoke test only guards the wiring.
    expect(typeof workerDefault.scheduled).toBe('function');
  });

  it('fetch delegates to the Hono app (round-trips /health)', async () => {
    // Sprint 1 / Slice 1.2 — the host-check middleware refuses
    // 421 on dev when the Host is not localhost / 127.0.0.1 /
    // *.workers.dev. Use a localhost URL so the host gate lets
    // the request through and we can assert the actual /health
    // payload.
    const req = new Request('http://localhost:8787/health', { method: 'GET' });
    // `app.fetch` accepts an optional ExecutionContext and we do
    // not need it for a /health round-trip — pass `undefined` so
    // the test stays framework-free.
    const res = await workerDefault.fetch(req, mockEnv(), undefined);

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('ok');
  });
});

/* ------------------------------------------------------------------ */
/*  /health/ready (Sprint 11 / Slice 11.2 — Epic CN.9.4)                */
/* ------------------------------------------------------------------ */

describe('/health/ready readiness probe', () => {
  /**
   * Dev environment with empty bindings — both probes resolve to
   * `skipped` and the handler reports `ready` because skipped is
   * dev-tolerable. This is the local-dev case where neither
   * Postgres nor Upstash is wired.
   */
  it('returns 200 ready in dev when DB_URL and REDIS_URL are blank', async () => {
    const app = buildApp();
    const res = await app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'localhost:8787' } },
      mockEnv({ ENVIRONMENT: 'dev', DB_URL: '', REDIS_URL: '' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      status: string;
      checks: { db: { status: string }; redis: { status: string } };
    }>();
    expect(body.status).toBe('ready');
    expect(body.checks.db.status).toBe('skipped');
    expect(body.checks.redis.status).toBe('skipped');
  });

  /**
   * Production environment with empty bindings — `skipped` becomes
   * a hard failure (configuration bug) so the probe returns 503.
   * Deploy automation reads the 503 and holds traffic.
   */
  it('returns 503 not_ready in staging when DB_URL is missing', async () => {
    const app = buildApp();
    const res = await app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'staging.api.athlya.app' } },
      mockEnv({
        ENVIRONMENT: 'staging',
        CORS_ORIGIN: 'https://app.staging.athlya.app',
        DB_URL: '',
        REDIS_URL: 'https://redis.example',
        REDIS_TOKEN: 'token',
        CRON_DB_URL: 'postgresql://athlya_cron@localhost/athlya',
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.json<{ status: string; checks: { db: { status: string } } }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.db.status).toBe('skipped');
  });

  it('returns 503 not_ready in production when DB_URL is missing', async () => {
    const app = buildApp();
    const res = await app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'api.athlya.app' } },
      mockEnv({
        ENVIRONMENT: 'production',
        CORS_ORIGIN: 'https://app.athlya.app',
        DB_URL: '',
        REDIS_URL: '',
        REDIS_TOKEN: '',
        CRON_DB_URL: 'postgresql://athlya_cron@localhost/athlya',
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.json<{
      status: string;
      checks: { db: { status: string }; redis: { status: string } };
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.db.status).toBe('skipped');
    expect(body.checks.redis.status).toBe('skipped');
  });

  it('returns 503 not_ready in production when CRON_DB_URL is missing', async () => {
    const app = buildApp();
    const res = await app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'api.athlya.app' } },
      mockEnv({
        ENVIRONMENT: 'production',
        CORS_ORIGIN: 'https://app.athlya.app',
        DB_URL: 'postgresql://example',
        REDIS_URL: 'https://redis.example',
        REDIS_TOKEN: 'token',
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.json<{
      status: string;
      checks: { cron: { status: string; error?: string } };
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.cron.status).toBe('skipped');
    expect(body.checks.cron.error).toContain('CRON_DB_URL');
  });

  it('returns 503 not_ready in staging when HYPERDRIVE is not bound', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));
    const app = buildApp();
    const res = await app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'staging.api.athlya.app' } },
      mockEnv({
        ENVIRONMENT: 'staging',
        CORS_ORIGIN: 'https://app.staging.athlya.app',
        DB_URL: 'postgresql://example',
        REDIS_URL: 'https://redis.example',
        REDIS_TOKEN: 'token',
        CRON_DB_URL: 'postgresql://athlya_cron@localhost/athlya',
      }),
    );
    fetchSpy.mockRestore();

    expect(res.status).toBe(503);
    const body = await res.json<{
      status: string;
      checks: { hyperdrive: { status: string; error?: string } };
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.hyperdrive.status).toBe('skipped');
    expect(body.checks.hyperdrive.error).toContain('HYPERDRIVE');
  });

  /**
   * The handler must NOT touch the database from `/health` — only
   * `/health/ready` does. This guards the contract: liveness vs
   * readiness split.
   */
  it('/health stays dependency-free even when /health/ready probes fail', async () => {
    const app = buildApp();
    // Liveness probe — must answer 200 regardless of binding state.
    const liveness = await app.request(
      '/health',
      { method: 'GET' },
      mockEnv({ ENVIRONMENT: 'dev', DB_URL: '', REDIS_URL: '' }),
    );
    expect(liveness.status).toBe(200);
    const livenessBody = await liveness.json<{ status: string }>();
    expect(livenessBody.status).toBe('ok');
  });
});
