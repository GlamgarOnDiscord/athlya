/**
 * Unit tests for the OpenTelemetry tracing middleware (task 8.6).
 *
 * Coverage:
 *   1. Span writer is attached to the context BEFORE `next()` runs
 *      and carries a `traceId` that matches the inbound
 *      `traceparent` header when valid, a fresh 32-hex id when the
 *      header is absent or malformed.
 *   2. Automatic attributes are collected after `next()` returns:
 *      `http.method`, `http.route`, `http.status_code`. When
 *      `authClaims` was populated during the request, `studio.id`
 *      and `user.id` are stamped too.
 *   3. When `OTEL_EXPORTER_OTLP_ENDPOINT` is absent, the middleware
 *      builds a span but performs no fetch.
 *   4. When the endpoint is configured, exactly one POST is made to
 *      it with `content-type: application/json` and the parsed
 *      headers from `OTEL_EXPORTER_OTLP_HEADERS` applied.
 *   5. An export failure (fetch rejects, non-2xx response) is
 *      swallowed and surfaced via `logger.warn` — the request never
 *      observes the failure.
 *   6. `parseOtelHeaders` parses the OTel env convention.
 *
 * Validates: Requirements 14.5, 30.1, 30.2, 30.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging.js';
import {
  parseOtelHeaders,
  tracing,
  type TraceSpan,
  type TracingContext,
} from '../middleware/otel.js';

import type { StructuredLogger } from '../logging.js';
import type { AthlyaBindings } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal {@link AthlyaBindings}. OTel fields are left
 * undefined by default so the "no export" branch is the zero-config
 * default.
 */
function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  const base: AthlyaBindings = {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_QUEUE'],
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
 * Build a fake {@link TracingContext} with controllable inputs.
 *
 * `variables` mirrors Hono's `c.get/set` storage — the test asserts
 * the middleware writes `span` here BEFORE `next()` runs by peeking
 * into the bag from inside the `next` spy.
 */
function fakeContext(
  args: {
    env?: AthlyaBindings;
    method?: string;
    url?: string;
    routePath?: string;
    status?: number;
    headers?: Record<string, string>;
    variables?: Record<string, unknown>;
    logger?: StructuredLogger;
    executionCtx?: { waitUntil(p: Promise<unknown>): void };
  } = {},
) {
  const headers = new Map(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const variables: Record<string, unknown> = {
    traceId: 'test-trace-id',
    logger: args.logger ?? createLogger({ traceId: 'test-trace-id', env: 'dev' }),
    startedAt: 1_000,
    ...(args.variables ?? {}),
  };
  const responseHeaders: Record<string, string> = {};

  const c: TracingContext = {
    env: args.env ?? mockEnv(),
    req: {
      method: args.method ?? 'GET',
      url: args.url ?? 'https://example.com/v1/classes',
      header(name: string): string | undefined {
        return headers.get(name.toLowerCase());
      },
      ...(args.routePath !== undefined ? { routePath: args.routePath } : {}),
    },
    res: {
      status: args.status ?? 200,
    },
    ...(args.executionCtx !== undefined ? { executionCtx: args.executionCtx } : {}),
    get(key: string): never {
      return variables[key] as never;
    },
    set(key: string, value: unknown): void {
      variables[key] = value;
    },
    header(name: string, value: string): void {
      responseHeaders[name] = value;
    },
  };
  return { c, variables, responseHeaders };
}

/** Cast through `unknown` to satisfy the narrow getters on the test double. */
function span(variables: Record<string, unknown>): TraceSpan | undefined {
  return variables['span'] as TraceSpan | undefined;
}

/* ------------------------------------------------------------------ */
/*  Console silencing — the logger writes JSON lines we do not need.   */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Span writer wiring                                                 */
/* ------------------------------------------------------------------ */

describe('tracing — span writer', () => {
  it('sets c.get("span") BEFORE next() runs', async () => {
    const { c, variables } = fakeContext();
    const middleware = tracing();

    let spanInsideNext: TraceSpan | undefined;
    const next = vi.fn(async () => {
      spanInsideNext = span(variables);
    });

    await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(spanInsideNext).toBeDefined();
    expect(spanInsideNext!.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(spanInsideNext!.spanId).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('reuses the trace-id from a valid inbound traceparent header', async () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const parentId = '0123456789abcdef';
    const { c, variables } = fakeContext({
      headers: { traceparent: `00-${traceId}-${parentId}-01` },
    });

    await tracing()(c, vi.fn().mockResolvedValue(undefined));

    expect(span(variables)!.traceId).toBe(traceId);
  });

  it('generates a fresh trace-id when the traceparent header is malformed', async () => {
    const { c, variables } = fakeContext({
      headers: { traceparent: 'not-a-real-header' },
    });

    await tracing()(c, vi.fn().mockResolvedValue(undefined));

    const id = span(variables)!.traceId;
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('generates a fresh trace-id when no traceparent header is present', async () => {
    const { c, variables } = fakeContext();

    await tracing()(c, vi.fn().mockResolvedValue(undefined));

    expect(span(variables)!.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('honours span.setName() override and does not auto-derive (Sprint 12 / B7.3)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c, variables } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      routePath: '/v1/auth/login',
      method: 'POST',
      status: 200,
    });

    // Simulate a domain handler calling `span.setName('auth.login')`
    // mid-request.
    const next = vi.fn(async () => {
      const s = span(variables);
      s?.setName('auth.login');
    });

    await tracing({ fetch: fetchSpy })(c, next);

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{ name: string }>;
        }>;
      }>;
    };
    const exportedName = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name;
    expect(exportedName).toBe('auth.login');
  });

  it('falls back to "${method} ${route}" when setName is not called', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      routePath: '/v1/classes',
      method: 'GET',
      status: 200,
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{ name: string }>;
        }>;
      }>;
    };
    const exportedName = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name;
    expect(exportedName).toBe('GET /v1/classes');
  });
});

/* ------------------------------------------------------------------ */
/*  Automatic attributes                                               */
/* ------------------------------------------------------------------ */

describe('tracing — automatic attributes', () => {
  it('collects http.method, http.route and http.status_code', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      method: 'POST',
      routePath: '/v1/reservations',
      status: 201,
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{
            attributes: ReadonlyArray<{ key: string; value: unknown }>;
          }>;
        }>;
      }>;
    };
    const attrs = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const attrMap = new Map(attrs.map((a) => [a.key, a.value as any]));
    expect(attrMap.get('http.method')).toEqual({ stringValue: 'POST' });
    expect(attrMap.get('http.route')).toEqual({ stringValue: '/v1/reservations' });
    expect(attrMap.get('http.status_code')).toEqual({ intValue: '201' });
  });

  it('falls back to URL pathname when routePath is missing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      url: 'https://example.com/some/unknown/path',
      status: 404,
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{
            attributes: ReadonlyArray<{ key: string; value: unknown }>;
          }>;
        }>;
      }>;
    };
    const attrs = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const attrMap = new Map(attrs.map((a) => [a.key, a.value as any]));
    expect(attrMap.get('http.route')).toEqual({
      stringValue: '/some/unknown/path',
    });
  });

  it('stamps studio.id and user.id when authClaims is populated during the request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c, variables } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      routePath: '/v1/members/me',
      status: 200,
    });

    // Simulate the auth middleware populating authClaims mid-request.
    const next = vi.fn(async () => {
      variables['authClaims'] = {
        userId: 'user-42',
        studioId: 'studio-7',
        role: 'member',
      };
    });

    await tracing({ fetch: fetchSpy })(c, next);

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{
            attributes: ReadonlyArray<{ key: string; value: unknown }>;
          }>;
        }>;
      }>;
    };
    const attrs = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const attrMap = new Map(attrs.map((a) => [a.key, a.value as any]));
    expect(attrMap.get('studio.id')).toEqual({ stringValue: 'studio-7' });
    expect(attrMap.get('user.id')).toEqual({ stringValue: 'user-42' });
  });

  it('omits studio.id and user.id when authClaims is absent (public routes)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      routePath: '/health',
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{
            attributes: ReadonlyArray<{ key: string }>;
          }>;
        }>;
      }>;
    };
    const keys = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map((a) => a.key);
    expect(keys).not.toContain('studio.id');
    expect(keys).not.toContain('user.id');
  });

  it('allows domain code to add a custom attribute mid-request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c, variables } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
    });

    const next = vi.fn(async () => {
      span(variables)?.addAttribute('reservation.id', 'res-1');
    });
    await tracing({ fetch: fetchSpy })(c, next);

    const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      resourceSpans: ReadonlyArray<{
        scopeSpans: ReadonlyArray<{
          spans: ReadonlyArray<{
            attributes: ReadonlyArray<{ key: string; value: unknown }>;
          }>;
        }>;
      }>;
    };
    const attrs = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const attrMap = new Map(attrs.map((a) => [a.key, a.value as any]));
    expect(attrMap.get('reservation.id')).toEqual({ stringValue: 'res-1' });
  });
});

/* ------------------------------------------------------------------ */
/*  Export toggling                                                    */
/* ------------------------------------------------------------------ */

describe('tracing — OTLP export', () => {
  it('skips the fetch when OTEL_EXPORTER_OTLP_ENDPOINT is absent', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c, variables } = fakeContext();

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    expect(fetchSpy).not.toHaveBeenCalled();
    // Span was still built and ended so domain code that reads
    // it during the request sees a coherent writer.
    expect(span(variables)).toBeDefined();
  });

  it('posts a single request to the configured endpoint with content-type and custom headers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { c } = fakeContext({
      env: mockEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.axiom.co/v1/traces',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret-token,x-extra=v', // gitleaks:allow
      }),
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.axiom.co/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-api-key']).toBe('secret-token'); // gitleaks:allow
    expect(init.headers['x-extra']).toBe('v');
    // Body parses as JSON — we do not re-assert the envelope
    // shape here (it is covered by the attribute tests above).
    expect(() => JSON.parse(init.body)).not.toThrow();
  });

  it('registers the export promise with executionCtx.waitUntil when available', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const waitUntil = vi.fn();
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      executionCtx: { waitUntil },
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const [promise] = waitUntil.mock.calls[0] as [Promise<unknown>];
    await promise; // drain so the warn-on-non-2xx path is exercised.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a fetch rejection and logs a warning instead of throwing', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    const warn = vi.fn();
    const logger: StructuredLogger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
    };
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      logger,
    });

    // The middleware itself must not reject.
    await expect(
      tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined)),
    ).resolves.toBeUndefined();

    // Let the detached promise settle so the catch-handler runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = warn.mock.calls[0] as [string, { error: string; traceId: string }];
    expect(msg).toBe('otel export failed');
    expect(fields.error).toBe('network down');
  });

  it('swallows a non-2xx response and logs a warning', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const warn = vi.fn();
    const logger: StructuredLogger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
    };
    const { c } = fakeContext({
      env: mockEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' }),
      logger,
    });

    await tracing({ fetch: fetchSpy })(c, vi.fn().mockResolvedValue(undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg] = warn.mock.calls[0] as [string, unknown];
    expect(msg).toBe('otel export non-2xx');
  });
});

/* ------------------------------------------------------------------ */
/*  parseOtelHeaders                                                   */
/* ------------------------------------------------------------------ */

describe('parseOtelHeaders', () => {
  it('returns an empty record for undefined and empty input', () => {
    expect(parseOtelHeaders(undefined)).toEqual({});
    expect(parseOtelHeaders('')).toEqual({});
  });

  it('parses the OTel env convention: k1=v1,k2=v2', () => {
    const raw = 'x-api-key=secret,x-team=eu'; // gitleaks:allow
    expect(parseOtelHeaders(raw)).toEqual({
      'x-api-key': 'secret',
      'x-team': 'eu',
    });
  });

  it('trims whitespace around keys and values', () => {
    const raw = ' x-api-key = hunter2 , x-extra = v '; // gitleaks:allow
    expect(parseOtelHeaders(raw)).toEqual({
      'x-api-key': 'hunter2',
      'x-extra': 'v',
    });
  });

  it('drops entries without an = or with an empty key', () => {
    expect(parseOtelHeaders('nosep,=novalue,x=y')).toEqual({ x: 'y' });
  });
});
