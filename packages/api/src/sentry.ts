/**
 * Minimal Sentry envelope client — task 8.7.
 *
 * Satisfies Requirement 30.3:
 *
 *   "WHEN an unhandled exception occurs in a Worker, THE API_Gateway
 *    SHALL attempt to capture it in Sentry with the `traceId` as a
 *    tag, and SHALL continue processing the response even if the
 *    Sentry capture call fails."
 *
 * Why no `@sentry/cloudflare`?
 * ---------------------------
 * The official SDK pulls in the OpenTelemetry auto-instrumentation
 * tree plus the full breadcrumb / session machinery; the bundle
 * blows past the Workers free-tier 1 MiB compressed ceiling even
 * after tree-shaking. What we actually need is a single HTTP POST
 * against the DSN-derived ingest URL with a three-line envelope
 * payload — under 2 KB of code, no transitive deps, and we control
 * the serialisation surface end-to-end.
 *
 * This module implements the informal Sentry protocol v7 envelope
 * format: one header JSON line, one item-header JSON line, one item
 * payload JSON line, all separated by `\n`. The header includes the
 * envelope event id and the DSN; each item carries a type and a
 * payload. See the public Sentry "Envelope" protocol doc for the
 * canonical shape — the key constraint is that `X-Sentry-Auth`
 * carries `sentry_version=7` along with the public key, so the
 * ingest endpoint can authenticate the POST without a session token.
 *
 * Behaviour contract:
 *
 *   1. `dsn` absent / empty  → factory returns a no-op client whose
 *      `captureException` is a zero-work `() => Promise.resolve()`.
 *      A single `warn` line is logged at module load so operators
 *      notice the missing config; the gateway continues to serve.
 *   2. `dsn` parseable       → factory returns a real client. Each
 *      call builds an envelope, POSTs it, and SWALLOWS every error.
 *      Errors never propagate back to the caller — Req 30.3
 *      explicitly says the response path must continue regardless.
 *   3. Injected `fetch`      → tests pass a stub. Production uses the
 *      Workers global `fetch`.
 *
 * Integration with the gateway's `onError` is the caller's job. When
 * task 8.5 lands the Problem Details error middleware, the factory
 * below will be instantiated once at module scope and the onError
 * handler will call `sentry.captureException(err, { traceId, tags })`
 * for 5xx responses only. Until 8.5 ships, consumers can use
 * {@link captureUnhandled} as a drop-in helper that reads the trace
 * id and environment off the Hono context.
 */

import type { AthlyaEnvironment } from './types.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Options a caller can pass to {@link SentryClient.captureException}.
 *
 * - `traceId` — the W3C trace id flowing through the gateway. Shows
 *   up as `tags.trace_id` in the Sentry event so the triage
 *   dashboard can pivot between a log line and the associated
 *   incident in one click.
 * - `tags`    — extra key/value pairs merged over the default tag
 *   bag. Use for `env`, `path`, `status`.
 * - `extra`   — free-form JSON surfaced on the event's `extra`
 *   field. Useful for request-scoped context that is too verbose
 *   for a tag.
 */
export interface CaptureExceptionOptions {
  readonly traceId?: string;
  readonly tags?: Record<string, string>;
  readonly extra?: Record<string, unknown>;
}

/**
 * Minimal client surface exposed to the gateway and tests.
 *
 * `captureException` always returns a resolved Promise; implementors
 * are required to swallow transport errors internally. Callers who
 * `await` the return value observe completion, never failure.
 */
export interface SentryClient {
  captureException(err: unknown, opts?: CaptureExceptionOptions): Promise<void>;
}

/**
 * Factory options. `fetch` is optional so tests can inject a stub
 * without monkey-patching the global; production omits it and the
 * client uses the Workers `fetch` global.
 */
export interface CreateSentryClientOptions {
  readonly dsn?: string;
  readonly environment: AthlyaEnvironment;
  readonly release?: string;
  readonly fetch?: typeof fetch;
}

/* ------------------------------------------------------------------ */
/*  DSN parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolved pieces of a Sentry DSN that the envelope POST needs.
 *
 * A canonical DSN looks like:
 *   `https://<publicKey>@<host>/<projectId>`
 *
 * From which the ingest URL for the `envelope` endpoint is:
 *   `https://<host>/api/<projectId>/envelope/`
 *
 * Path prefixes (e.g. Sentry self-hosted with a sub-path) are
 * preserved in `ingestBaseUrl`.
 */
interface ResolvedDsn {
  readonly publicKey: string;
  readonly projectId: string;
  readonly ingestBaseUrl: string;
}

/**
 * Parse a DSN string. Returns `null` for anything the factory should
 * treat as "no Sentry configured" (empty string, malformed URL,
 * missing public key or project id).
 *
 * Kept tolerant: we never throw on a bad DSN — operators mis-pasting
 * the DSN should not crash the gateway at boot. A single `warn` line
 * is emitted by the factory when parsing fails.
 */
function parseDsn(dsn: string | undefined): ResolvedDsn | null {
  if (dsn === undefined || dsn.length === 0) return null;

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }

  const publicKey = url.username;
  // The project id is the last non-empty path segment. Sentry
  // self-hosted installations sometimes sit under a sub-path
  // (`/sentry/api/`), so we keep everything but the last segment
  // as the base path.
  const rawSegments = url.pathname.split('/').filter((s) => s.length > 0);
  if (publicKey.length === 0 || rawSegments.length === 0) return null;

  const projectId = rawSegments.at(-1) as string;
  const basePath = rawSegments.slice(0, -1).join('/');
  const ingestBaseUrl =
    basePath.length === 0
      ? `${url.protocol}//${url.host}`
      : `${url.protocol}//${url.host}/${basePath}`;

  return { publicKey, projectId, ingestBaseUrl };
}

/* ------------------------------------------------------------------ */
/*  Sprint-5 SP5.1 — Sentry EU residency check (Vague 33, S5-010)      */
/* ------------------------------------------------------------------ */

/**
 * Sentry hosts the EU residency dataset on `*.de.sentry.io` (or any
 * customer-provided EU subdomain on dedicated tenants). The audit
 * S5-010 flagged that nothing prevents a misconfigured deploy from
 * shipping a US-region DSN, which would route every captured event
 * (including `traceId`, request path, error class) to a US data
 * centre. RGPD Art 44+ requires explicit safeguards for transfers
 * outside the EU; routing logs to a US Sentry project without those
 * safeguards is a violation.
 *
 * `assertSentryDsnIsEu(dsn)` returns:
 *   - `null` when the DSN is empty / unset (no check needed).
 *   - `null` when the DSN host ends with `.de.sentry.io` or any
 *     known EU customer suffix (`.eu.sentry.io`, custom prefix
 *     `.athlya.eu.sentry.io`, …) — explicitly allow-listed.
 *   - A warning string when the DSN parses but the host does not
 *     match the EU allow-list. The caller decides whether to log,
 *     refuse boot, or both — `worker.ts` logs a single `error` line
 *     per isolate (boot is not aborted because the audit's
 *     mitigation is "fail loud, not blocked deploy" — operators get
 *     a clear log without breaking incident response).
 */
const SENTRY_EU_HOST_SUFFIXES: readonly string[] = [
  '.de.sentry.io',
  '.eu.sentry.io',
  // Sentry self-hosted EU instances run under customer-controlled
  // domains; teams can extend this list via configuration if
  // needed. The current deployment uses the SaaS EU dataset only.
];

export function assertSentryDsnIsEu(dsn: string | undefined): string | null {
  if (dsn === undefined || dsn.length === 0) return null;
  const parsed = parseDsn(dsn);
  if (parsed === null) {
    // Malformed DSN — let `createSentryClient` log its own
    // dedicated warning. We do not flag region issues on a DSN
    // we cannot parse.
    return null;
  }
  let host: string;
  try {
    host = new URL(parsed.ingestBaseUrl).host.toLowerCase();
  } catch {
    return null;
  }
  const isEu = SENTRY_EU_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (isEu) return null;
  return `Sentry DSN host '${host}' does not match the EU residency suffix list (${SENTRY_EU_HOST_SUFFIXES.join(', ')}); RGPD Art 44 transfer safeguards may be missing`;
}

/**
 * Build the envelope endpoint URL for a parsed DSN. Public for tests
 * only — production code never needs the string outside the client.
 */
export function buildIngestUrl(dsn: ResolvedDsn): string {
  return `${dsn.ingestBaseUrl}/api/${dsn.projectId}/envelope/`;
}

/* ------------------------------------------------------------------ */
/*  Envelope construction                                              */
/* ------------------------------------------------------------------ */

/** Sentry SDK identifier emitted on every event's `sdk` field. */
const SDK_NAME = 'athlya.api';
const SDK_VERSION = '0.1.0';

/** Fixed protocol version (v7 is the current Sentry envelope revision). */
const SENTRY_PROTOCOL_VERSION = '7';

/**
 * Build the `X-Sentry-Auth` header value. The order of fields is
 * not significant per spec, but we match Sentry's own SDKs so ingest
 * logs stay consistent.
 */
function buildAuthHeader(publicKey: string): string {
  return [
    `Sentry sentry_version=${SENTRY_PROTOCOL_VERSION}`,
    `sentry_client=${SDK_NAME}/${SDK_VERSION}`,
    `sentry_key=${publicKey}`,
  ].join(', ');
}

/**
 * One frame of a Sentry `stacktrace`. Field names follow the Sentry
 * event protocol (`filename`, `function`, `lineno`, `colno`, `in_app`).
 */
interface SentryStackFrame {
  filename: string;
  function?: string;
  lineno: number;
  colno: number;
  in_app: boolean;
}

/**
 * Matches a V8 stack line in either form:
 *   `    at fnName (file:///x/worker.js:12:34)`
 *   `    at file:///x/worker.js:12:34`
 * Capture groups: 1 = optional function name, 2 = file, 3 = line, 4 = col.
 */
const STACK_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/u;

/**
 * Parse an `Error.stack` string into Sentry stacktrace frames.
 *
 * Without this, the event carries only `type`/`value` and Sentry has
 * no `filename:lineno` to match against the uploaded source maps
 * (issue #138) — prod stacks would stay un-de-minified. We emit
 * frames so the release-tagged maps actually resolve.
 *
 * Sentry expects frames **oldest-first** (the crashing frame last),
 * which is the reverse of V8's top-down `stack` order — hence the
 * final `reverse()`.
 */
function parseStackFrames(stack: string): SentryStackFrame[] {
  const frames: SentryStackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = STACK_FRAME_RE.exec(line);
    if (m === null) continue;
    const fn = m[1];
    const filename = m[2];
    const lineno = Number(m[3]);
    const colno = Number(m[4]);
    if (filename === undefined || !Number.isFinite(lineno) || !Number.isFinite(colno)) {
      continue;
    }
    frames.push({
      filename,
      ...(fn !== undefined && fn.length > 0 ? { function: fn } : {}),
      lineno,
      colno,
      in_app: true,
    });
  }
  return frames.reverse();
}

/**
 * Serialise the thrown value into the Sentry-expected `exception`
 * shape. Non-Error throws (strings, plain objects) are normalised so
 * we never send an empty event. When the `Error` carries a `stack`,
 * we parse it into `stacktrace.frames` so source-map de-minification
 * works (issue #138).
 */
function toExceptionPayload(err: unknown): {
  type: string;
  value: string;
  stacktrace?: { frames: SentryStackFrame[] };
} {
  if (err instanceof Error) {
    const base = {
      type: err.name.length > 0 ? err.name : 'Error',
      value: err.message.length > 0 ? err.message : '(no message)',
    };
    if (typeof err.stack === 'string' && err.stack.length > 0) {
      const frames = parseStackFrames(err.stack);
      if (frames.length > 0) {
        return { ...base, stacktrace: { frames } };
      }
    }
    return base;
  }
  // Everything else is coerced to a string. A richer parser is not
  // worth the bytes for a fallback path.
  return {
    type: 'NonErrorThrow',
    value: typeof err === 'string' ? err : safeStringify(err),
  };
}

/**
 * Last-ditch stringifier used for non-Error throws. Swallows every
 * serialisation failure because captureException must never throw.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '(unserialisable)';
  } catch {
    return '(unserialisable)';
  }
}

/**
 * Produce a UUID v4 with hyphens removed — Sentry's event id format.
 * Uses `crypto.randomUUID` where available (Workers, Node ≥ 19) and
 * falls back to a plain `Math.random`-based builder on runtimes
 * without it (old Node, some test sandboxes).
 */
function makeEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    const n = Math.floor(Math.random() * 16);
    out += n.toString(16);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * No-op client returned when the DSN is absent. Allocates nothing on
 * each call and resolves synchronously — the `async` keyword keeps
 * the method signature compatible with the live client.
 */
const NO_OP_CLIENT: SentryClient = {
  captureException: () => Promise.resolve(),
};

/**
 * Guard so we only `warn` once per isolate about a missing DSN.
 * Without this, a server with many captureException calls would spam
 * its logs with identical warnings.
 */
let warnedAboutMissingDsn = false;

/**
 * Build a {@link SentryClient}. See module doc for the full
 * behaviour contract.
 */
export function createSentryClient(opts: CreateSentryClientOptions): SentryClient {
  const resolved = parseDsn(opts.dsn);
  if (resolved === null) {
    if (!warnedAboutMissingDsn) {
      warnedAboutMissingDsn = true;
      // Single warn at factory construction time. Using
      // `console.warn` directly rather than `createLogger`
      // because `sentry.ts` must not pull the logger into its
      // import graph (the logger calls it from its own error
      // path, which would be a cycle waiting to happen).
      const reason = opts.dsn === undefined || opts.dsn.length === 0 ? 'missing' : 'unparseable';
      console.warn(`[sentry] DSN ${reason}; error capture disabled for env=${opts.environment}`);
    }
    return NO_OP_CLIENT;
  }

  const ingestUrl = buildIngestUrl(resolved);
  const authHeader = buildAuthHeader(resolved.publicKey);
  const fetchImpl = opts.fetch ?? fetch;

  return {
    async captureException(err, captureOpts) {
      try {
        const eventId = makeEventId();
        const sentAt = new Date().toISOString();

        const tags: Record<string, string> = {
          env: opts.environment,
          ...(captureOpts?.tags ?? {}),
        };
        if (captureOpts?.traceId !== undefined) {
          tags['trace_id'] = captureOpts.traceId;
        }

        const event: Record<string, unknown> = {
          event_id: eventId,
          timestamp: Date.now() / 1000,
          platform: 'javascript',
          level: 'error',
          environment: opts.environment,
          sdk: { name: SDK_NAME, version: SDK_VERSION },
          tags,
          exception: { values: [toExceptionPayload(err)] },
        };
        if (opts.release !== undefined) {
          event['release'] = opts.release;
        }
        if (captureOpts?.extra !== undefined) {
          event['extra'] = captureOpts.extra;
        }

        const header = JSON.stringify({
          event_id: eventId,
          sent_at: sentAt,
          dsn: opts.dsn,
        });
        const itemHeader = JSON.stringify({ type: 'event' });
        const itemPayload = JSON.stringify(event);
        const body = `${header}\n${itemHeader}\n${itemPayload}`;

        // Fire-and-forget POST. We still `await` the call so
        // the returned Promise resolves only after the
        // transport has settled — the caller can rely on
        // ordering (capture before sending the HTTP response)
        // when they choose to await.
        await fetchImpl(ingestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': authHeader,
          },
          body,
        });
      } catch {
        // Per Req 30.3: Sentry failures must never disrupt
        // the primary response path. We intentionally swallow
        // the error with no rethrow. A logger call here would
        // risk re-entering the `onError` path and looping, so
        // we stay silent — the resulting missed event is a
        // known, accepted degradation.
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Hono integration helper                                            */
/* ------------------------------------------------------------------ */

/**
 * Minimal context shape read by {@link captureUnhandled}. Matches
 * the live Hono `Context<HonoEnv>` structurally but avoids importing
 * `hono` so the module remains framework-free.
 */
export interface CaptureUnhandledContext {
  readonly env: {
    readonly ENVIRONMENT: AthlyaEnvironment;
    readonly SENTRY_DSN?: string;
    readonly VERSION?: string;
  };
  readonly req: {
    readonly path?: string;
    readonly method?: string;
  };
  get(key: 'traceId'): string;
}

/**
 * Cached per-bindings client. Re-creating a client on every request
 * would re-parse the DSN and rebuild the auth header on the hot
 * path; caching by `SENTRY_DSN` keeps every captureException call to
 * a single envelope build + POST.
 *
 * The cache key is the DSN string itself (it encodes the public key
 * + project id). Different environments therefore get different
 * entries and never cross-pollinate.
 */
const clientCache = new Map<string, SentryClient>();

/** Build a cache key from `(environment, dsn, release)` so a change
 *  to any of them produces a fresh client. */
function cacheKey(opts: {
  environment: AthlyaEnvironment;
  dsn: string | undefined;
  release: string | undefined;
}): string {
  return `${opts.environment}|${opts.dsn ?? ''}|${opts.release ?? ''}`;
}

/**
 * Capture an unhandled exception using the client derived from the
 * Hono context bindings. Intended to be called from the gateway's
 * `onError` handler (task 8.5) for 5xx responses only — 4xx errors
 * are user-triggered and must NOT page on-call.
 *
 * Tags:
 *   - `env`      — deployment target (`dev` | `staging` | `production`)
 *   - `path`     — request path
 *   - `method`   — HTTP method
 *   - `trace_id` — W3C trace id flowing through the gateway
 */
export async function captureUnhandled(
  err: unknown,
  c: CaptureUnhandledContext,
  extraTags?: Record<string, string>,
): Promise<void> {
  const key = cacheKey({
    environment: c.env.ENVIRONMENT,
    dsn: c.env.SENTRY_DSN,
    release: c.env.VERSION,
  });
  let client = clientCache.get(key);
  if (client === undefined) {
    // `exactOptionalPropertyTypes` forbids passing an
    // `undefined`-valued property to an optional field; build the
    // options object conditionally so the factory sees either a
    // string or no `dsn` property at all.
    const factoryOpts: CreateSentryClientOptions = {
      environment: c.env.ENVIRONMENT,
      ...(c.env.SENTRY_DSN !== undefined ? { dsn: c.env.SENTRY_DSN } : {}),
      ...(c.env.VERSION !== undefined ? { release: c.env.VERSION } : {}),
    };
    client = createSentryClient(factoryOpts);
    clientCache.set(key, client);
  }

  const tags: Record<string, string> = { ...(extraTags ?? {}) };
  if (c.req.path !== undefined) tags['path'] = c.req.path;
  if (c.req.method !== undefined) tags['method'] = c.req.method;

  await client.captureException(err, {
    traceId: c.get('traceId'),
    tags,
  });
}

/** Test-only helper — clear the module-scope client cache. */
export function __resetSentryCacheForTests(): void {
  clientCache.clear();
  warnedAboutMissingDsn = false;
}
