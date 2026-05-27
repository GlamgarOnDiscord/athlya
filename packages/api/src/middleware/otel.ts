/**
 * OpenTelemetry tracing middleware (task 8.6).
 *
 * Satisfies Requirements 14.5, 30.1, 30.2 and 30.4:
 *
 *   • 14.5 — The API_Gateway SHALL propagate the W3C `traceparent`
 *            header through every downstream call and emit
 *            OpenTelemetry spans to the OTLP endpoint (default: Axiom).
 *   • 30.1 — The API_Gateway SHALL emit an OTel span for every
 *            incoming request with the attributes `http.method`,
 *            `http.route`, `http.status_code`, `studio.id` (when
 *            known) and `user.id` (when known).
 *   • 30.2 — The API_Gateway SHALL forward every emitted span to
 *            the OTLP endpoint (default: Axiom).
 *   • 30.4 — Each served-log line continues to carry the `traceId`
 *            so Loki / Tail Workers queries stay stitched against
 *            Axiom traces.
 *
 * ### Why a hand-rolled OTLP exporter?
 *
 * The official `@opentelemetry/api` + `@opentelemetry/sdk-trace-*`
 * bundle weighs 200 KB+ on the Worker bundle (after tree-shaking the
 * browser trace context propagator) and pulls in polyfills we do not
 * need. Axiom (and every other OTLP/HTTP JSON backend) only consumes
 * the OTLP/HTTP JSON envelope and that
 * envelope has a stable, small surface: a single POST with a
 * `ResourceSpans` body. Building the envelope by hand keeps the
 * Worker under its 1 MB compiled-size budget and avoids the SDK's
 * global-singleton contention model, which fights Worker isolates.
 *
 * ### Behaviour per request
 *
 *   1. Read the inbound `traceparent` header. When valid, reuse the
 *      32-hex `trace-id` and capture the 16-hex `parent-span-id`
 *      so the emitted span stitches onto the upstream trace. When
 *      absent or malformed, generate a fresh 32-hex trace-id and
 *      leave `parentSpanId` undefined.
 *   2. Generate a fresh 16-hex span-id for THIS request.
 *   3. Build a {@link TraceSpan} writer with `addAttribute`,
 *      `addEvent` and `end` and store it on the Hono context as the
 *      `span` variable (see `types.ts`). Seed it with the canonical
 *      `http.method` attribute.
 *   4. Call `next()` so the downstream pipeline runs.
 *   5. On return, stamp the automatic attributes (`http.route`,
 *      `http.status_code`, `studio.id`, `user.id`) from the
 *      request / response / `authClaims` that downstream middleware
 *      populated, then call `span.end()`. Ending the span collects
 *      the final envelope.
 *   6. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, fire a non-
 *      blocking POST to the exporter with the envelope as JSON.
 *      Wrapped in `c.executionCtx.waitUntil` when the Worker
 *      runtime exposes one; otherwise the promise is left
 *      detached. Export failure is swallowed and logged at `warn`
 *      level on the per-request logger (30.2 is best-effort — we
 *      must never crash the request because the OTel backend is down).
 *
 * ### What this module does NOT do
 *
 *   • It does not read `traceId` off the Hono context. The tracing
 *      middleware in `worker.ts` (task 8.1) keeps the
 *      `logger / traceId / startedAt` scaffolding unchanged; this
 *      file operates on the side so the log shape stays stable.
 *   • It does not stitch into `@opentelemetry/api`'s global
 *      `trace.getTracer(...)`. Domain code that needs a child span
 *      pulls the writer from `c.get('span')` and adds an attribute
 *      or event; real nested span emission is deferred to task
 *      8.7 (circuit breaker) which has a legitimate need for
 *      per-dependency timings.
 *   • It does not touch `worker.ts`' error envelopes. The span
 *      status is inferred from `c.res.status` at `end()` time:
 *      `OK` below 500, `ERROR` at / above 500.
 *
 * The module is intentionally framework-free at the type level — a
 * {@link TracingContext} duck-type keeps the factory portable across
 * Hono and any router that exposes the same surface, matching the
 * style used by `security-headers.ts` and `rate-limit.ts`.
 */

import { newSpanId, newTraceIdHex, extractTraceparent } from '../tracing/ids.js';

import type { StructuredLogger } from '../logging.js';
import type { AthlyaBindings } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Instrumentation scope name emitted on every `scopeSpans` entry.
 * The OTel backend (Axiom by default) groups spans by this value on
 * the UI. Keeping it stable
 * across the whole API surface makes the gateway's spans cluster
 * together regardless of which route emitted them.
 */
const SCOPE_NAME = '@athlya/api';

/** Instrumentation scope version. Bumped alongside the package. */
const SCOPE_VERSION = '0.0.0';

/** OTLP span kind for inbound HTTP requests. */
const SPAN_KIND_SERVER = 2 as const;

/** OTLP `Status.code` values. */
const STATUS_CODE_UNSET = 0 as const;
const STATUS_CODE_OK = 1 as const;
const STATUS_CODE_ERROR = 2 as const;

/** Max fraction of `/health*` requests exported when env rate is higher. */
export const OTEL_HEALTH_SAMPLE_RATE = 0.01;

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Attribute values the writer accepts. OTLP supports richer types
 * (arrays, doubles, kvlist) but the gateway only ever emits string,
 * number or boolean scalars — keeping the surface tight avoids any
 * ambiguity in the envelope serialiser.
 */
export type SpanAttributeValue = string | number | boolean;

/**
 * Per-request OTel span writer. Stored on the Hono context under the
 * `span` variable (see `types.ts`) so domain handlers can enrich the
 * span without importing the middleware.
 *
 * The shape is intentionally minimal:
 *
 *   • `traceId` / `spanId` — 32-hex / 16-hex identifiers echoed on
 *     outbound headers and consumed by child spans (task 8.7).
 *   • `addAttribute` / `addEvent` — idempotent writers that buffer
 *     the data until the span ends. Calls are no-ops after `end()`
 *     so an accidental post-end write cannot desync the envelope.
 *   • `end` — finalise the span. Called exactly once by the
 *     middleware; domain code should NOT call it directly.
 */
export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  addAttribute(key: string, value: SpanAttributeValue): void;
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void;
  /**
   * Sprint 12 / Slice 12.9 (Epic B7.3) — set the span name to
   * a `<verb>.<domain>` flavour. Idempotent and last-write-wins;
   * callers in domain handlers should invoke this once at the
   * start of their handler so the OTel backend groups spans by
   * business operation rather than by HTTP route template.
   *
   * Examples: `'auth.login'`, `'reservations.book'`,
   * `'members.profile.update'`. The default
   * `${method} ${route}` is used when this is not called.
   */
  setName(name: string): void;
  end(): void;
}

/**
 * Minimal request-context shape accepted by {@link tracing}. Hono's
 * `Context<HonoEnv>` satisfies this interface structurally — the
 * middleware drops into a Hono app via `app.use('*', tracing())`
 * without a cast. The shape is also trivially implementable in
 * tests so we never need a full Hono pipeline for unit-level
 * assertions.
 *
 * `res.status` is read AFTER `next()` returns. Hono stamps the
 * final response status on `c.res` by then, including on error
 * envelopes emitted by `onError`.
 */
export interface TracingContext {
  readonly env: AthlyaBindings;
  readonly req: {
    method: string;
    url: string;
    header(name: string): string | undefined;
    /**
     * Route template registered on the handler, e.g. `/v1/classes/:id`.
     * Hono's `HonoRequest.routePath` matches this shape; the field
     * may be the empty string or `'/'` on middleware-only
     * requests — the middleware falls back to the pathname in
     * those cases.
     */
    readonly routePath?: string;
  };
  readonly res: {
    readonly status: number;
  };
  /**
   * Optional Cloudflare `ExecutionContext`. When present we register
   * the export fetch via `waitUntil`; when absent the export
   * promise is fired and detached.
   */
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void };

  get(key: 'traceId'): string;
  get(key: 'logger'): StructuredLogger;
  get(key: 'authClaims'): { userId: string; studioId: string; role: string } | undefined;
  get(key: 'span'): TraceSpan | undefined;
  get(key: string): unknown;

  set(key: 'span', value: TraceSpan): void;

  header(name: string, value: string): void;
}

/** Hono-compatible middleware signature, typed minimally. */
export type TracingMiddleware = (c: TracingContext, next: () => Promise<void>) => Promise<void>;

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

/**
 * Options for {@link tracing}. All fields are optional — the factory
 * falls back to production defaults.
 */
/**
 * Resolve the OTLP export sample rate for the current deployment.
 *
 * `OTEL_SAMPLE_RATE` (0–1) overrides per-env defaults:
 *   production → 0.1, staging → 0.5, dev → 1.0.
 */
export function resolveOtelSampleRate(
  env: Pick<AthlyaBindings, 'ENVIRONMENT' | 'OTEL_SAMPLE_RATE'>,
): number {
  const raw = env.OTEL_SAMPLE_RATE;
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  switch (env.ENVIRONMENT) {
    case 'production':
      return 0.1;
    case 'staging':
      return 0.5;
    default:
      return 1;
  }
}

function isHealthProbeRoute(route: string): boolean {
  return route === '/health' || route === '/health/ready' || route.startsWith('/health/');
}

/**
 * Decide whether to POST the OTLP envelope after the request completes.
 *
 *   • 5xx responses are always exported (tail sampling).
 *   • `/health*` probes use `min(envRate, OTEL_HEALTH_SAMPLE_RATE)`.
 *   • Other routes use `envRate` with uniform random sampling.
 *
 * Spans are still built in-memory either way so `traceId` logging is unchanged.
 */
export function shouldExportOtelTrace(opts: {
  httpStatus: number;
  route: string;
  sampleRate: number;
  rng?: () => number;
}): boolean {
  if (opts.httpStatus >= 500) {
    return true;
  }
  const rng = opts.rng ?? Math.random;
  let effectiveRate = opts.sampleRate;
  if (isHealthProbeRoute(opts.route)) {
    effectiveRate = Math.min(effectiveRate, OTEL_HEALTH_SAMPLE_RATE);
  }
  if (effectiveRate >= 1) {
    return true;
  }
  if (effectiveRate <= 0) {
    return false;
  }
  return rng() < effectiveRate;
}

export interface TracingOptions {
  /**
   * Service name emitted as the `service.name` resource attribute.
   * Defaults to `'athlya-api'`. Axiom (and every OTLP backend) groups
   * spans by this value on the APM dashboard.
   */
  serviceName?: string;

  /**
   * Override the wall-clock used for span start / end timestamps.
   * Defaults to `Date.now()`. Tests inject a frozen clock so
   * `startTimeUnixNano` / `endTimeUnixNano` assertions are
   * reproducible.
   */
  now?: () => number;

  /**
   * Inject the fetch implementation used to POST the OTLP envelope.
   * Defaults to the global `fetch`. Tests pass a `vi.fn()` spy so
   * no network I/O happens.
   */
  fetch?: typeof fetch;

  /**
   * RNG for probabilistic export (tests inject a deterministic value).
   */
  random?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Envelope types (minimal OTLP/HTTP JSON shape)                      */
/* ------------------------------------------------------------------ */

interface OtlpAttributeKeyValue {
  readonly key: string;
  readonly value:
    | { readonly stringValue: string }
    | { readonly intValue: string }
    | { readonly doubleValue: number }
    | { readonly boolValue: boolean };
}

interface OtlpEvent {
  readonly timeUnixNano: string;
  readonly name: string;
  readonly attributes: readonly OtlpAttributeKeyValue[];
}

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: typeof SPAN_KIND_SERVER;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpAttributeKeyValue[];
  readonly events: readonly OtlpEvent[];
  readonly status: {
    readonly code: typeof STATUS_CODE_UNSET | typeof STATUS_CODE_OK | typeof STATUS_CODE_ERROR;
  };
}

interface OtlpScopeSpans {
  readonly scope: { readonly name: string; readonly version: string };
  readonly spans: readonly OtlpSpan[];
}

interface OtlpResourceSpans {
  readonly resource: { readonly attributes: readonly OtlpAttributeKeyValue[] };
  readonly scopeSpans: readonly OtlpScopeSpans[];
}

interface OtlpEnvelope {
  readonly resourceSpans: readonly OtlpResourceSpans[];
}

/* ------------------------------------------------------------------ */
/*  Attribute encoding                                                  */
/* ------------------------------------------------------------------ */

/**
 * Encode a {@link SpanAttributeValue} into OTLP's `AnyValue` shape.
 *
 * We use `intValue` for finite integers (OTLP requires the value
 * serialised as a string — the spec treats `intValue` as a 64-bit
 * signed int and JSON has no native int64) and `doubleValue` for
 * everything else. Booleans and strings map straight through.
 */
function encodeAttributeValue(value: SpanAttributeValue): OtlpAttributeKeyValue['value'] {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'number':
      if (Number.isInteger(value) && Number.isFinite(value)) {
        return { intValue: value.toString(10) };
      }
      return { doubleValue: value };
  }
}

function encodeAttributes(
  attrs: Readonly<Record<string, SpanAttributeValue>>,
): readonly OtlpAttributeKeyValue[] {
  const out: OtlpAttributeKeyValue[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    out.push({ key, value: encodeAttributeValue(value) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Header parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS` per the OTel environment
 * convention:
 *
 *   `key1=value1,key2=value2`
 *
 * Whitespace around `key` and `value` is trimmed. Entries without
 * an `=` or with an empty key are silently dropped — a misformatted
 * secret must not crash a Worker request. Returns an empty record
 * when `raw` is `undefined` or empty.
 *
 * Exported for direct unit testing; production code calls it via the
 * cached resolver inside {@link tracing}.
 */
export function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.length === 0) {
    return {};
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Span writer                                                        */
/* ------------------------------------------------------------------ */

/**
 * Internal mutable state backing a {@link TraceSpan}. Kept in a
 * dedicated record (rather than closure variables) so the `finalize`
 * helper below can project it into an OTLP span without guessing
 * field names.
 */
interface SpanState {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  name: string;
  /**
   * Sprint 12 / Slice 12.9 (Epic B7.3) — true when a domain
   * handler called `span.setName(...)`. Stops the post-`next()`
   * step from clobbering the override with `${method} ${route}`.
   */
  nameOverridden: boolean;
  startTimeMs: number;
  endTimeMs: number | null;
  attributes: Record<string, SpanAttributeValue>;
  events: Array<{
    timeMs: number;
    name: string;
    attributes: Record<string, SpanAttributeValue>;
  }>;
  ended: boolean;
}

/**
 * Build a new {@link TraceSpan} writer.
 *
 * `startTimeMs` is captured eagerly so the attribute on the span
 * reflects the moment the middleware ran, not the moment `end()` is
 * called.
 */
function createSpan(state: SpanState, now: () => number): TraceSpan {
  const span: TraceSpan = {
    traceId: state.traceId,
    spanId: state.spanId,
    addAttribute(key, value) {
      if (state.ended) return;
      state.attributes[key] = value;
    },
    addEvent(name, attributes) {
      if (state.ended) return;
      state.events.push({
        timeMs: now(),
        name,
        attributes: { ...(attributes ?? {}) },
      });
    },
    setName(name) {
      // Sprint 12 / Slice 12.9 (Epic B7.3) — allow domain
      // handlers to override the default `${method} ${route}`
      // span name with a `<verb>.<domain>` flavour
      // (`auth.login`, `reservations.book`, …). The override
      // sticks unless the span has already been finalised.
      if (state.ended) return;
      if (typeof name === 'string' && name.length > 0) {
        state.name = name;
        // Mark as explicitly set so the auto-derived
        // `${method} ${route}` step at end of `next()` does
        // NOT clobber the operator-provided value.
        state.nameOverridden = true;
      }
    },
    end() {
      if (state.ended) return;
      state.ended = true;
      state.endTimeMs = now();
    },
  };
  return span;
}

/**
 * Convert millisecond-since-epoch to the stringified nanoseconds the
 * OTLP JSON encoding requires. JSON has no native int64, so the spec
 * uses string-encoded decimal integers. We avoid BigInt arithmetic
 * because the multiplication stays within `Number.MAX_SAFE_INTEGER`
 * for any realistic timestamp (year-2255 era — well outside the
 * service's lifetime).
 */
function msToNanoString(ms: number): string {
  // Multiplying by 1e6 is safe for every ms value below
  // Number.MAX_SAFE_INTEGER / 1e6 ≈ 9.0e9, i.e. ~2255 AD.
  return `${Math.round(ms * 1e6).toString(10)}`;
}

/**
 * Finalise a {@link SpanState} into the OTLP `ResourceSpans`
 * envelope the OTel backend consumes.
 *
 * Attribute rules:
 *   • `resource.attributes.service.name` — taken from `serviceName`.
 *   • `resource.attributes.deployment.environment` — the named
 *     environment (`dev` / `staging` / `production`) so the OTel
 *     backend filters span populations per env.
 *   • `scopeSpans[].scope` — pinned to `@athlya/api`.
 *   • `spans[].status.code` — `OK` when `http.status_code < 500`,
 *     `ERROR` at / above 500, `UNSET` when unknown.
 */
function buildEnvelope(state: SpanState, serviceName: string, environment: string): OtlpEnvelope {
  const statusCodeAttr = state.attributes['http.status_code'];
  let statusCode: OtlpSpan['status']['code'] = STATUS_CODE_UNSET;
  if (typeof statusCodeAttr === 'number') {
    statusCode = statusCodeAttr >= 500 ? STATUS_CODE_ERROR : STATUS_CODE_OK;
  }

  const endTimeMs = state.endTimeMs ?? state.startTimeMs;

  const span: OtlpSpan = {
    traceId: state.traceId,
    spanId: state.spanId,
    ...(state.parentSpanId !== undefined ? { parentSpanId: state.parentSpanId } : {}),
    name: state.name,
    kind: SPAN_KIND_SERVER,
    startTimeUnixNano: msToNanoString(state.startTimeMs),
    endTimeUnixNano: msToNanoString(endTimeMs),
    attributes: encodeAttributes(state.attributes),
    events: state.events.map((e) => ({
      timeUnixNano: msToNanoString(e.timeMs),
      name: e.name,
      attributes: encodeAttributes(e.attributes),
    })),
    status: { code: statusCode },
  };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: encodeAttributes({
            'service.name': serviceName,
            'deployment.environment': environment,
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: [span],
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Route / path helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Determine the route template attached to this request. Hono
 * populates `c.req.routePath` with the matched route (`/v1/classes/:id`)
 * on the final matched handler. Middleware-scoped contexts — and the
 * 404 fallback — may leave it empty or `'/'`; we fall back to the
 * request pathname in those cases so the attribute is always
 * present.
 */
function deriveRoute(c: TracingContext): string {
  const routePath = c.req.routePath;
  if (typeof routePath === 'string' && routePath.length > 0 && routePath !== '/') {
    return routePath;
  }
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return '/';
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the OTel tracing middleware. See module doc for the full
 * behaviour contract.
 *
 * Returns a Hono-compatible middleware. Mounting is the caller's
 * responsibility — `worker.ts` registers it globally on the app in
 * the skeleton built by task 8.1.
 */
export function tracing(options: TracingOptions = {}): TracingMiddleware {
  const serviceName = options.serviceName ?? 'athlya-api';
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const rng = options.random ?? Math.random;

  return async (c, next) => {
    // Step 1 — parse inbound traceparent.
    const incoming = c.req.header('traceparent') ?? null;
    const parsed = extractTraceparent(incoming);
    const traceIdHex = parsed?.traceId ?? newTraceIdHex();
    const state: SpanState = {
      traceId: traceIdHex,
      spanId: newSpanId(),
      ...(parsed !== null ? { parentSpanId: parsed.parentSpanId } : {}),
      name: `${c.req.method} ${deriveRoute(c)}`,
      nameOverridden: false,
      startTimeMs: now(),
      endTimeMs: null,
      attributes: {
        'http.method': c.req.method,
      },
      events: [],
      ended: false,
    };

    const span = createSpan(state, now);

    // Step 2 — inject the writer so downstream middleware can
    //          enrich the span. Name is refreshed after `next()`
    //          returns because the route is only known on the
    //          final matched handler.
    c.set('span', span);

    // Step 3 — run the downstream pipeline. We swallow no
    //          errors here — `onError` in `worker.ts` owns the
    //          error envelope. On throw we still want the span
    //          exported, so the `finally` block runs.
    try {
      await next();
    } finally {
      // Step 4 — stamp automatic attributes. Route / status /
      //           claims are only known after `next()` runs.
      const route = deriveRoute(c);
      // Sprint 12 / Slice 12.9 (B7.3) — only auto-derive the
      // span name when the handler has NOT explicitly called
      // `span.setName(...)`. The override carries the
      // business-operation flavour (`auth.login`, …) which is
      // what the OTel backend should group on.
      if (!state.nameOverridden) {
        state.name = `${c.req.method} ${route}`;
      }
      state.attributes['http.route'] = route;
      state.attributes['http.status_code'] = c.res.status;

      const claims = c.get('authClaims');
      if (claims !== undefined) {
        state.attributes['studio.id'] = claims.studioId;
        state.attributes['user.id'] = claims.userId;
      }

      span.end();

      // Step 5 — export. Swallowed on failure so a dead
      //           OTel backend never crashes the request.
      const endpoint = c.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const sampleRate = resolveOtelSampleRate(c.env);
      const exportTrace =
        typeof endpoint === 'string' &&
        endpoint.length > 0 &&
        shouldExportOtelTrace({
          httpStatus: c.res.status,
          route,
          sampleRate,
          rng,
        });
      if (exportTrace) {
        const envelope = buildEnvelope(state, serviceName, c.env.ENVIRONMENT);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...parseOtelHeaders(c.env.OTEL_EXPORTER_OTLP_HEADERS),
        };
        const logger = c.get('logger');
        const exportTask = fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(envelope),
        })
          .then((res) => {
            if (!res.ok) {
              logger.warn('otel export non-2xx', {
                status: res.status,
                traceId: state.traceId,
              });
            }
          })
          .catch((err: unknown) => {
            logger.warn('otel export failed', {
              traceId: state.traceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        if (c.executionCtx !== undefined) {
          c.executionCtx.waitUntil(exportTask);
        } else {
          // Detached — we must keep a reference to avoid
          // unhandled-rejection warnings in Node test
          // environments, but the promise itself is
          // fire-and-forget from the request's perspective.
          void exportTask;
        }
      }
    }
  };
}
