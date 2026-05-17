/**
 * Transport & browser security headers — framework-agnostic builder and
 * Hono-compatible middleware.
 *
 * Satisfies Requirements 25.1, 25.2 and 25.4:
 *
 *   • 25.1 — The API gateway SHALL accept only TLS 1.3 connections.
 *            TLS is terminated at Cloudflare and is configured in the
 *            dashboard (Min TLS Version = 1.3). Nothing in the Worker
 *            can enforce a lower-layer protocol; we still emit HSTS so
 *            clients refuse downgraded connections going forward.
 *   • 25.2 — Emit `Strict-Transport-Security: max-age=63072000;
 *            includeSubDomains; preload` on every response.
 *   • 25.4 — Emit `X-Frame-Options: DENY` and
 *            `Referrer-Policy: strict-origin` on every response.
 *
 * Two additional hardening headers ship with the defaults because they
 * are free of side effects on our surface and defuse well-known web
 * classes of attack:
 *
 *   • `X-Content-Type-Options: nosniff` — disables MIME sniffing, a
 *     documented XSS vector when a misconfigured server returns user
 *     content with an ambiguous `content-type`.
 *   • `Permissions-Policy: camera=(), microphone=(), geolocation=()` —
 *     disables the three most commonly abused powerful APIs. The admin
 *     kiosk (QR scanner) and mobile web surface will opt in per-origin
 *     in later tasks; the API gateway itself never needs these.
 *
 * Why a framework-free module?
 * ----------------------------
 * Hono is a peer dependency of `@athlya/api`, not a runtime import. The
 * Hono gateway skeleton (task 8.1) is not landed yet, but the header
 * policy needs to be shared with workers and adjacent edge routers.
 * Keeping this module hono-free means:
 *   • It can be wired into Hono via `app.use('*', securityHeaders())`.
 *   • It can be wired into any router whose context exposes
 *     `header(key, value)` (the Hono shape coincides with most
 *     small routers — itty-router with a header shim, Sunder, Worktop).
 *   • It can be called directly on a plain `Response` via
 *     {@link applySecurityHeaders}, e.g. in queue consumers replying
 *     to HTTP probes.
 *
 * Content-Security-Policy is intentionally NOT in scope of this task.
 * Req 25.3 is owned by task 10.1 (web app) which issues a per-request
 * nonce through the Next.js middleware. Callers wanting a CSP on a
 * specific surface can pass it via {@link SecurityHeadersOptions.extraHeaders}.
 */

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

/**
 * HSTS `max-age` in seconds.
 *
 * Set to 63,072,000 (2 years), the minimum requested by Chrome's HSTS
 * preload list (https://hstspreload.org/) and explicitly named in
 * Req 25.2. Shorter values would disqualify the domain from the
 * preload list even if everything else is correct.
 */
const DEFAULT_HSTS_MAX_AGE_SECONDS = 63_072_000;

/**
 * Readonly record of the five default headers emitted by
 * {@link buildSecurityHeaders} when no options are supplied.
 *
 * Frozen so a caller-side mutation (`DEFAULT_SECURITY_HEADERS['X-Frame-Options'] = 'SAMEORIGIN'`)
 * fails loudly at the boundary instead of silently poisoning every
 * future request.
 */
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Strict-Transport-Security': `max-age=${String(DEFAULT_HSTS_MAX_AGE_SECONDS)}; includeSubDomains; preload`,
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

/**
 * Reserved header names — {@link SecurityHeadersOptions.extraHeaders}
 * must NEVER overwrite one of these. Matching is case-insensitive
 * (HTTP header names are case-insensitive per RFC 7230 §3.2).
 *
 * The list is derived from {@link DEFAULT_SECURITY_HEADERS} at module
 * load time so it can never drift out of sync.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_SECURITY_HEADERS).map((k) => k.toLowerCase()),
);

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

/**
 * Overrides for the default header set.
 *
 * Every field is optional; the builder falls back to the values in
 * {@link DEFAULT_SECURITY_HEADERS} when a field is absent. `extraHeaders`
 * is intentionally merged last and cannot overwrite a reserved security
 * header — that invariant is documented in {@link buildSecurityHeaders}.
 */
export interface SecurityHeadersOptions {
  /**
   * HSTS `max-age` directive in seconds.
   *
   * Defaults to {@link DEFAULT_HSTS_MAX_AGE_SECONDS} (2 years). Must
   * be a non-negative finite integer; values below 0 are clamped to
   * 0 by the builder (RFC 6797 §6.1.1).
   */
  hstsMaxAgeSeconds?: number;

  /**
   * Whether to include the `includeSubDomains` HSTS directive.
   * Defaults to `true`.
   */
  hstsIncludeSubDomains?: boolean;

  /**
   * Whether to include the `preload` HSTS directive.
   * Defaults to `true`. Only meaningful when
   * {@link hstsIncludeSubDomains} is also `true` and `max-age` ≥
   * 31,536,000 — those preconditions are the caller's responsibility.
   */
  hstsPreload?: boolean;

  /**
   * `X-Frame-Options` header value. Defaults to `'DENY'`.
   *
   * `SAMEORIGIN` is the only other RFC-legal value (the obsolete
   * `ALLOW-FROM` is intentionally not exposed).
   */
  frameOptions?: 'DENY' | 'SAMEORIGIN';

  /**
   * `Referrer-Policy` header value. Defaults to `'strict-origin'`.
   *
   * Typed as `string` rather than a closed union because the Fetch
   * spec defines several legal values (e.g. `no-referrer`,
   * `strict-origin-when-cross-origin`) and future additions should
   * not require a code change here.
   */
  referrerPolicy?: string;

  /**
   * `Permissions-Policy` header value. Defaults to the value in
   * {@link DEFAULT_SECURITY_HEADERS}.
   */
  permissionsPolicy?: string;

  /**
   * Extra headers to merge with the defaults. Entries whose key
   * (case-insensitive) clashes with a reserved security header are
   * dropped so callers cannot accidentally weaken the baseline.
   *
   * Intended for adding non-reserved headers such as
   * `Content-Security-Policy` (task 10.1 owns the per-request nonce),
   * `Report-To`, `Cross-Origin-Opener-Policy`, etc.
   */
  extraHeaders?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compose the Strict-Transport-Security directive string.
 *
 * RFC 6797 requires a non-negative `max-age`; negative or non-finite
 * values are clamped to 0 which disables HSTS rather than emitting a
 * malformed header.
 */
function buildHstsValue(options: SecurityHeadersOptions): string {
  const rawMaxAge = options.hstsMaxAgeSeconds ?? DEFAULT_HSTS_MAX_AGE_SECONDS;
  const maxAge = Number.isFinite(rawMaxAge) && rawMaxAge >= 0 ? Math.floor(rawMaxAge) : 0;
  const includeSubDomains = options.hstsIncludeSubDomains ?? true;
  const preload = options.hstsPreload ?? true;

  const parts: string[] = [`max-age=${String(maxAge)}`];
  if (includeSubDomains) {
    parts.push('includeSubDomains');
  }
  if (preload) {
    parts.push('preload');
  }
  return parts.join('; ');
}

/**
 * Pure builder — returns a fresh, plain object containing the final
 * header set to apply to a response.
 *
 * Invariants:
 *   • The five reserved header keys in {@link DEFAULT_SECURITY_HEADERS}
 *     are always present in the output.
 *   • {@link SecurityHeadersOptions.extraHeaders} entries are merged
 *     last but CANNOT overwrite a reserved key (case-insensitive).
 *   • The returned object is a plain `Record<string, string>` so it
 *     can be iterated with `Object.entries` and passed to
 *     `new Headers(...)`.
 */
export function buildSecurityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const frameOptions = options.frameOptions ?? 'DENY';
  const referrerPolicy = options.referrerPolicy ?? 'strict-origin';
  const permissionsPolicy =
    options.permissionsPolicy ?? DEFAULT_SECURITY_HEADERS['Permissions-Policy'];

  const headers: Record<string, string> = {
    'Strict-Transport-Security': buildHstsValue(options),
    'X-Frame-Options': frameOptions,
    'Referrer-Policy': referrerPolicy,
    'X-Content-Type-Options': 'nosniff',
    // `permissionsPolicy` is guaranteed to be a string by the
    // default above, but `exactOptionalPropertyTypes` makes the
    // compiler re-check, so we coerce through `String()` to remain
    // resilient to future `Permissions-Policy` type widening.
    'Permissions-Policy': String(permissionsPolicy),
  };

  if (options.extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(options.extraHeaders)) {
      if (RESERVED_HEADER_NAMES.has(key.toLowerCase())) {
        // Silently drop: the reserved default wins. Logging a
        // warning here would force a logger dependency on this
        // otherwise pure module; callers that want to be told
        // can sanity-check their own config ahead of time.
        continue;
      }
      headers[key] = value;
    }
  }

  return headers;
}

/* ------------------------------------------------------------------ */
/*  Response adapter                                                   */
/* ------------------------------------------------------------------ */

/**
 * Return a NEW {@link Response} identical to `response` but with every
 * entry in `headers` set (replacing any existing value at the same
 * name). The original response is cloned via `response.clone()` so its
 * body stream remains readable by the caller.
 *
 * Why immutable?
 * --------------
 * The Fetch spec's {@link Response} body is a single-shot
 * {@link ReadableStream}. Mutating headers on an already-returned
 * response is legal in the web standard but forbidden once the body
 * has been consumed; worker runtimes additionally freeze `Response`
 * instances in various edge-case code paths. Returning a fresh
 * instance avoids every such footgun.
 */
export function applySecurityHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  const cloned = response.clone();
  const merged = new Headers(cloned.headers);
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value);
  }
  return new Response(cloned.body, {
    status: cloned.status,
    statusText: cloned.statusText,
    headers: merged,
  });
}

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

/**
 * Minimal context shape accepted by {@link securityHeaders}.
 *
 * Hono's `Context.header(key, value)` matches this surface exactly, so
 * the middleware drops into a Hono app via `app.use('*', securityHeaders())`
 * without a type cast. The same shape is also trivially implemented by
 * any router whose outgoing response is collected in a header bag.
 */
export interface SecurityHeadersContext {
  header: (key: string, value: string) => void;
}

/**
 * Hono-compatible middleware signature, typed minimally so this module
 * can remain framework-free. Returning `Promise<void>` is compatible
 * with Hono's `MiddlewareHandler` contract (Hono accepts
 * `void | Response`; we just never short-circuit).
 */
export type SecurityHeadersMiddleware = (
  c: SecurityHeadersContext,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Build a middleware that writes the configured security headers onto
 * the outgoing response.
 *
 * Behaviour:
 *   1. Computes the final header set once per middleware instance
 *      (not once per request) — options never change at runtime and
 *      the builder is pure, so the memoisation is sound.
 *   2. Calls `c.header(key, value)` for every entry in the header set
 *      BEFORE awaiting `next()`. Hono merges these into the final
 *      response irrespective of whether the downstream handler emits
 *      its own `c.json(...)` / `c.body(...)` call.
 *   3. Awaits `next()` exactly once so downstream middleware and the
 *      eventual handler run normally.
 *
 * The headers are emitted before `next()` on purpose: if a downstream
 * handler throws, the error middleware (task 8.5) still responds with
 * Problem Details, and we want the security headers present on that
 * error response too.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): SecurityHeadersMiddleware {
  const headers = buildSecurityHeaders(options);
  const entries = Object.entries(headers);

  return async (c, next) => {
    for (const [key, value] of entries) {
      c.header(key, value);
    }
    await next();
  };
}
