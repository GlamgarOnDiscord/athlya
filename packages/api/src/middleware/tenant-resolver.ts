/**
 * Tenant resolution from the HTTP `Host` header and request path —
 * framework-free helper shared by the Hono API gateway (task 8.3) and
 * the Next.js web/studio middleware (task 10.1).
 *
 * Satisfies Requirements 13.1 and 13.5:
 *
 *   • 13.1 — The API_Gateway SHALL set `app.user_id`, `app.studio_id`
 *            and `app.role` via `SET LOCAL` on every authenticated
 *            transaction. The `studio_id` is looked up from the slug
 *            produced by this resolver, making tenant resolution the
 *            single entry point that feeds RLS.
 *   • 13.5 — A request whose host or path does not resolve to a known
 *            tenant SHALL NOT disclose resource existence. Returning a
 *            `{ source: 'none' }` value lets callers respond with 404
 *            at the edge rather than 403 after a database lookup.
 *
 * Why framework-free?
 * -------------------
 * The resolver has to run in two very different environments:
 *
 *   1. The Hono API gateway on Cloudflare Workers, where it is invoked
 *      per request via `app.use('*', tenantResolver())` (task 8.3).
 *   2. The Next.js web/studio apps, where it is invoked from
 *      `middleware.ts` running on the Edge runtime (task 10.1). That
 *      context is not Hono, so a Hono-specific middleware would not
 *      compose.
 *
 * Keeping the core as a pure function makes it trivial to wrap in
 * either integration point and, equally importantly, to unit-test
 * without spinning up a full router.
 *
 * What about the mobile app?
 * --------------------------
 * Mobile clients never resolve a tenant by host — there is no domain
 * attached to the request. Instead the selected studio slug is stored
 * per logged-in account in MMKV and transmitted as an `X-Studio-Slug`
 * header on every request. The resolver intentionally does NOT inspect
 * that header: the gateway reads it separately after authentication
 * because the slug must be cross-checked against the JWT's
 * `studio_id` claim, which lives in a different part of the pipeline.
 */

/* ------------------------------------------------------------------ */
/*  Reserved subdomains                                                */
/* ------------------------------------------------------------------ */

/**
 * Subdomains that are NEVER interpreted as tenant slugs.
 *
 * Each entry serves a platform-level purpose that must not collide
 * with a studio's slug even if the slug would otherwise match
 * {@link SLUG_REGEX}. The list is a `readonly` tuple (via `as const`)
 * so TypeScript preserves the literal types at call sites that care
 * (e.g. typing a union of admin-only routes).
 *
 * Callers can extend this set at runtime via
 * {@link TenantResolverOptions.reservedSubdomains} — the defaults are
 * always enforced in addition to any extension, never replaced.
 */
export const RESERVED_SUBDOMAINS = [
  // `www.athlya.app` serves the canonical marketing site and should
  // redirect to the apex; it is never a tenant.
  'www',
  // `api.athlya.app` is the gateway's own host. Treating it as a
  // tenant would make the gateway try to look up a studio named
  // "api" on every request.
  'api',
  // `admin.athlya.app` is the platform-level admin console (not to
  // be confused with a studio's admin area, which lives at
  // `{slug}.athlya.app/admin`).
  'admin',
  // `app.athlya.app` is reserved for the generic app shell / SSO
  // landing that does not belong to any one studio.
  'app',
  // `staging.athlya.app` runs the pre-production environment on a
  // separate origin so cookies and CSP do not leak into prod.
  'staging',
  // `dev.athlya.app` is the shared development environment.
  'dev',
  // `auth.athlya.app` is reserved for the OAuth/SSO issuer host so
  // that identity URLs remain stable across studio domains.
  'auth',
  // `status.athlya.app` hosts the public status page.
  'status',
] as const;

/* ------------------------------------------------------------------ */
/*  Slug regex                                                         */
/* ------------------------------------------------------------------ */

/**
 * DNS-compatible slug pattern.
 *
 * A slug must:
 *   • be 3–63 characters long (RFC 1035 label limit);
 *   • consist of lowercase letters, digits and hyphens;
 *   • neither start nor end with a hyphen (RFC 952 / RFC 1123).
 *
 * The `{1,61}` quantifier covers the middle; with the mandatory
 * start/end characters that gives 1 + 1 + 1 = 3 minimum and
 * 1 + 61 + 1 = 63 maximum.
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Path prefix pattern.
 *
 * Captures the slug from `/s/{slug}` followed by either `/` (there is
 * more path to route) or end-of-string (the slug is the whole path).
 * The capture group is intentionally the same class as {@link SLUG_REGEX}
 * so that a slug matched here is guaranteed to also satisfy it.
 *
 * Paths are case-sensitive per RFC 3986 §6.2.2.1: a mixed-case path
 * such as `/s/ACME/...` will not match, and the caller receives
 * `{ source: 'none' }`. That behaviour is exercised by the tests.
 */
const PATH_PREFIX_REGEX = /^\/s\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])(\/|$)/;

/**
 * IPv4 literal, e.g. `192.168.1.10`. IPv6 literals are detected via
 * the leading `[` instead — after port stripping, a bracketed host is
 * the standard Host-header form for IPv6 (RFC 7230 §5.4).
 */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Input for {@link resolveTenant}.
 *
 * `host` is the raw `Host` header value — possibly with port, possibly
 * mixed-case, possibly a bracketed IPv6 literal. `path` is the request
 * pathname only (no query string, no fragment); the caller is expected
 * to strip those before dispatching.
 */
export interface TenantResolutionInput {
  host: string;
  path: string;
}

/**
 * Discriminated union describing the outcome of tenant resolution.
 *
 * A `'subdomain'` result identifies the studio by host; the downstream
 * router receives the original path unchanged.
 *
 * A `'path'` result carries `pathWithoutPrefix` — the `/s/{slug}`
 * prefix stripped — so the router can match its normal
 * `/v1/classes`, `/v1/reservations` … routes without caring that the
 * request came in under a path tenant.
 *
 * A `'none'` result means the request does not target a tenant (apex
 * marketing site, reserved subdomain, dev hosts, malformed slug …).
 * The caller decides what to do — redirect to marketing, 404, render
 * a tenant picker — but it must NOT use an arbitrary fallback studio.
 */
export type TenantResolution =
  | { source: 'subdomain'; slug: string }
  | { source: 'path'; slug: string; pathWithoutPrefix: string }
  | { source: 'none' };

/**
 * Optional overrides for {@link resolveTenant}.
 */
export interface TenantResolverOptions {
  /**
   * Apex host the tenant subdomains hang off. Defaults to
   * {@link DEFAULT_APEX_HOST}. Useful for staging domains
   * (`staging.athlya.app`-based subdomains), local development with
   * a custom hosts file, and white-label deployments that use a
   * different apex entirely.
   */
  apexHost?: string;

  /**
   * Additional reserved subdomains, merged with
   * {@link RESERVED_SUBDOMAINS}. Cannot shrink the default set —
   * the defaults are always enforced.
   */
  reservedSubdomains?: readonly string[];
}

const DEFAULT_APEX_HOST = 'athlya.app';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Strip the optional `:port` suffix from a Host header value and
 * lowercase the result.
 *
 * Two forms are handled:
 *
 *   • IPv6 literals are bracketed per RFC 7230 §5.4, e.g. `[::1]:8080`.
 *     The port lives after the closing `]`; everything up to and
 *     including the `]` is kept.
 *   • All other hosts accept a trailing `:digits` that is removed if
 *     present. A trailing `:` followed by a non-numeric suffix is
 *     treated as part of the host (malformed but we don't silently
 *     "fix" it).
 */
function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }

  let hostOnly: string;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) {
      // Malformed IPv6 literal — keep verbatim so the caller
      // gets `{ source: 'none' }` via the IP-literal fast path.
      hostOnly = trimmed;
    } else {
      hostOnly = trimmed.slice(0, end + 1);
    }
  } else {
    const colon = trimmed.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(trimmed.slice(colon + 1))) {
      hostOnly = trimmed.slice(0, colon);
    } else {
      hostOnly = trimmed;
    }
  }

  return hostOnly.toLowerCase();
}

/**
 * `true` when the host is a raw IP literal that cannot possibly be a
 * tenant subdomain. Bracketed IPv6 (`[::1]`, `[fe80::1]`) and any
 * four-dotted-quad IPv4 literal short-circuit the subdomain branch.
 */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[')) {
    return true;
  }
  return IPV4_REGEX.test(host);
}

/**
 * `true` when the host is the literal string `localhost`. Other
 * `*.localhost` names (e.g. `acme.localhost`, common in tools like
 * Caddy) are intentionally NOT matched here: they are treated as
 * ordinary hosts that simply fail to end with the configured
 * `apexHost`. Tests using `localhost` as a dev apex can pass
 * `{ apexHost: 'localhost' }` explicitly.
 */
function isLocalhost(host: string): boolean {
  return host === 'localhost';
}

/* ------------------------------------------------------------------ */
/*  resolveTenant                                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolve the tenant studio for a request.
 *
 * Algorithm (spec'd by task 15.1):
 *   1. Normalize the host — strip port, lowercase.
 *   2. Short-circuit to step 4 if the host is the apex, an IP literal,
 *      or `localhost` — none of those can carry a tenant subdomain.
 *   3. If the host is exactly `{sub}.{apexHost}` and `sub` matches
 *      {@link SLUG_REGEX} and is not reserved, return
 *      `{ source: 'subdomain', slug: sub }`.
 *   4. Otherwise, attempt a path-based match against
 *      {@link PATH_PREFIX_REGEX}. On success, return
 *      `{ source: 'path', slug, pathWithoutPrefix }` where the prefix
 *      has been stripped (or `'/'` if nothing remained).
 *   5. Otherwise, return `{ source: 'none' }`.
 *
 * The function is pure and side-effect free; it performs no I/O and
 * does not look up the slug in the database. Callers validate the
 * slug exists as a follow-up step so that an unknown tenant produces
 * a 404 at the edge.
 */
export function resolveTenant(
  input: TenantResolutionInput,
  options: TenantResolverOptions = {},
): TenantResolution {
  const apexHost = (options.apexHost ?? DEFAULT_APEX_HOST).toLowerCase();
  const reserved: ReadonlySet<string> = new Set<string>(
    [...RESERVED_SUBDOMAINS, ...(options.reservedSubdomains ?? [])].map((s) => s.toLowerCase()),
  );

  const host = normalizeHost(input.host);

  // Step 2: decide whether step 3 can even apply.
  const canTrySubdomain =
    host.length > 0 && host !== apexHost && !isIpLiteral(host) && !isLocalhost(host);

  // Step 3: subdomain match against `{sub}.{apexHost}`.
  if (canTrySubdomain) {
    const suffix = `.${apexHost}`;
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, host.length - suffix.length);
      if (SLUG_REGEX.test(sub) && !reserved.has(sub)) {
        return { source: 'subdomain', slug: sub };
      }
      // Reserved or malformed — fall through to step 4. A
      // reserved host with a path like `/s/acme/...` could
      // legally still pick up a tenant, though in practice
      // reserved surfaces never mount `/s/*` routes.
    }
  }

  // Step 4: path-based match `^/s/{slug}(/|$)`.
  const match = PATH_PREFIX_REGEX.exec(input.path);
  if (match !== null) {
    const slug = match[1];
    if (slug !== undefined) {
      const prefix = `/s/${slug}`;
      const rest = input.path.slice(prefix.length);
      const pathWithoutPrefix = rest.length === 0 || rest === '/' ? '/' : rest;
      return { source: 'path', slug, pathWithoutPrefix };
    }
  }

  // Step 5: nothing matched.
  return { source: 'none' };
}

/* ================================================================== */
/*  Hono integration — Slice 1.4 (Sprint 1 — SP1.5, finding S2-007)   */
/* ================================================================== */

/*
 * The two factories below wrap the framework-free {@link resolveTenant}
 * pure function in a Hono-compatible middleware pair so the gateway
 * can:
 *
 *   1. Annotate every request with its resolved tenant slug (or
 *      `'none'`) on the way in. Pure, infallible, no I/O.
 *      → {@link tenantResolverMiddleware}
 *
 *   2. Cross-check that slug against the verified JWT `studio` claim
 *      AFTER the auth middleware ran. A mismatch surfaces as a
 *      404 Problem Details (`code: 'tenant_mismatch'`) so the
 *      responder cannot infer that the slug-resolved tenant exists.
 *      → {@link tenantClaimGuard}
 *
 * Why two middlewares instead of one
 * ----------------------------------
 *   • The resolver runs BEFORE auth (no JWT to consult yet) — it
 *     runs as soon as the host is whitelisted, so every later
 *     middleware can read the slug if needed.
 *   • The cross-check runs AFTER auth — it needs `authClaims.studioId`
 *     posted by `jwtAuth()`. Splitting keeps each concern testable in
 *     isolation and matches the existing
 *     `securityHeaders()` / `tracing()` / `tenant()` factory style.
 *
 * Why import minimal context shapes (not Hono types)
 * --------------------------------------------------
 *   The pure resolver above stays framework-free; the wrappers stay
 *   framework-light by duck-typing the request context through
 *   {@link TenantResolverContext} and {@link TenantClaimGuardContext}.
 *   The live `Context<HonoEnv>` satisfies both interfaces structurally,
 *   so `app.use(tenantResolverMiddleware())` typechecks without a cast.
 */

/* ------------------------------------------------------------------ */
/*  tenantResolverMiddleware                                           */
/* ------------------------------------------------------------------ */

/**
 * Minimal Hono context surface used by {@link tenantResolverMiddleware}.
 *
 * Read paths: `req.header('host')`, `req.url`. Write paths:
 * `set('tenantSlug', …)`, `set('tenantSource', …)`. Hono's
 * `Context<HonoEnv>` exposes all four; we keep the shape duck-typed
 * so the middleware drops into a non-Hono router (e.g. tests with a
 * fabricated context) without a cast.
 */
export interface TenantResolverContext {
  readonly req: {
    header(name: string): string | undefined;
    readonly url: string;
  };
  set(key: 'tenantSlug', value: string | undefined): void;
  set(key: 'tenantSource', value: 'subdomain' | 'path' | 'none'): void;
}

/**
 * Hono-compatible middleware signature for the resolver wrapper.
 * Returns `Promise<void>` — the resolver never short-circuits the
 * pipeline (the cross-check below owns refusal). When the resolver
 * yields `'none'`, downstream code must not rely on `tenantSlug`
 * being set; the cross-check explicitly guards against that.
 */
export type TenantResolverMiddleware = (
  c: TenantResolverContext,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Build the host/path → tenant resolver middleware.
 *
 * Behaviour per request:
 *
 *   1. Read the `Host` header (lowercased downstream by the resolver)
 *      and the request pathname (stripped of query/fragment by
 *      `new URL(c.req.url).pathname`).
 *   2. Call {@link resolveTenant} with the supplied options. The
 *      pure function does NOT throw; on a malformed input it returns
 *      `{ source: 'none' }`.
 *   3. Stamp the result onto the context:
 *        • `tenantSource` is always set (one of `'subdomain'` /
 *          `'path'` / `'none'`).
 *        • `tenantSlug` is set ONLY for `'subdomain'` / `'path'`
 *          results — `'none'` leaves it `undefined` so a downstream
 *          guard can branch on `slug === undefined`.
 *   4. Continue the chain via `next()`. The resolver never refuses a
 *      request — that decision is delegated to {@link tenantClaimGuard}
 *      which compares the slug to the JWT `studio` claim.
 *
 * The middleware is intentionally infallible: a malformed `Host`
 * header (already filtered by `worker.ts`'s host-check at step 0) or
 * an unparsable URL (impossible in practice; `c.req.url` is supplied
 * by the runtime) collapses to `'none'`. We deliberately do NOT
 * throw or 4xx here — the host-check upstream already rejected the
 * obvious garbage, and the cross-check downstream owns the policy
 * decision.
 *
 * Mount it AFTER the host-check (`worker.ts` step 0) and BEFORE the
 * auth middleware (`jwtAuth()`):
 *
 * ```ts
 * app.use('*', tenantResolverMiddleware());
 * ```
 */
export function tenantResolverMiddleware(
  options: TenantResolverOptions = {},
): TenantResolverMiddleware {
  return async (c, next) => {
    // Real Cloudflare Worker requests always carry a `Host`
    // header; Hono's in-process `app.request(absoluteUrl, …)`
    // test harness drops it but parses the URL host out of the
    // first argument. Mirror the host-check fallback in
    // `worker.ts` so the middleware behaves identically across
    // both surfaces.
    let host = c.req.header('host') ?? '';
    if (host === '') {
      try {
        host = new URL(c.req.url).host;
      } catch {
        host = '';
      }
    }

    let path = '/';
    try {
      path = new URL(c.req.url).pathname;
    } catch {
      // `c.req.url` is supplied by the Workers runtime and is
      // guaranteed to be parseable; this catch is belt-and-
      // braces. A fabricated context with a garbage URL still
      // gets a sane fallback path so the resolver runs.
      path = '/';
    }

    const resolution = resolveTenant({ host, path }, options);

    c.set('tenantSource', resolution.source);
    if (resolution.source === 'subdomain' || resolution.source === 'path') {
      c.set('tenantSlug', resolution.slug);
    } else {
      c.set('tenantSlug', undefined);
    }

    await next();
  };
}

/* ------------------------------------------------------------------ */
/*  tenantClaimGuard — slug ↔ JWT studio cross-check                   */
/* ------------------------------------------------------------------ */

/**
 * Stable Problem Details code returned when the resolved tenant slug
 * does not match the JWT `studio` claim. Surfacing a dedicated code
 * (rather than the generic `not_found`) lets observability slice
 * cross-tenant probing attempts from legitimate 404s without
 * inspecting the body — the `code` is reflected on the wire as well
 * as in the structured log.
 */
export const TENANT_MISMATCH_CODE = 'tenant_mismatch' as const;

/**
 * Module-level cache of `slug → studioId` resolutions.
 *
 * Without a cache, every authenticated `/v1/*` request would issue a
 * `SELECT id FROM studios WHERE slug = $1 LIMIT 1` to the database —
 * a DDoS amplifier and a hot-path latency tax. The cache is keyed by
 * `(connectionString, slug)` so two distinct envs (dev / staging /
 * prod sharing one isolate during preview deploys) never share an
 * entry. The TTL is 60 s — long enough to absorb burst traffic,
 * short enough that a freshly-renamed slug propagates within a
 * minute (a corner case that does not occur on the hot path).
 *
 * Negative results (`null`) are cached too: a slug that does not map
 * to any studio is also a stable signal — a misconfigured DNS entry
 * or a slug typo shouldn't burn a DB round-trip per request.
 *
 * The cache lives in module scope so it is shared across all
 * middleware instances in the Worker isolate. A test seam
 * ({@link __resetTenantClaimGuardCache}) clears it for tests that
 * inject distinct fake studios across cases.
 */
interface TenantSlugCacheEntry {
  /** Studio UUID, or `null` when the slug is unknown. */
  readonly studioId: string | null;
  /** `Date.now()` after which the entry must be re-fetched. */
  readonly expiresAt: number;
}

const tenantSlugCache = new Map<string, TenantSlugCacheEntry>();

/**
 * Default cache TTL — 60 seconds. Documented as a constant so a
 * future change (or test override) is visible at a glance.
 */
const DEFAULT_TENANT_CACHE_TTL_MS = 60 * 1_000;

/**
 * Test-only seam that drops the slug→studioId cache so consecutive
 * tests can swap in fresh fake studios without residue.
 */
export function __resetTenantClaimGuardCache(): void {
  tenantSlugCache.clear();
}

/**
 * Build the composite cache key for a given env / slug pair.
 * Distinct DB URLs MUST NOT share entries — a slug `acme` could
 * resolve to studio `A` in dev and studio `B` in staging if a
 * preview deploy reused the same isolate.
 */
function cacheKey(dbUrl: string, slug: string): string {
  return `${dbUrl}\u0000${slug}`;
}

/**
 * Minimal contract the guard requires from a "studio lookup". The
 * production wiring builds this by binding the cached Drizzle client
 * + a `SELECT id FROM studios WHERE slug = $1` query; tests inject a
 * synchronous map.
 *
 * Returning `null` for an unknown slug is part of the contract — a
 * thrown error would be interpreted as DB unavailable and trigger
 * fail-open.
 */
export type StudioSlugResolver = (slug: string) => Promise<string | null>;

/**
 * Minimal Hono context surface read by {@link tenantClaimGuard}.
 *
 * Reads:
 *   • `tenantSlug` (set by {@link tenantResolverMiddleware});
 *   • `authClaims` (set by `jwtAuth()`);
 *   • `traceId` (set by the tracing middleware in `worker.ts`);
 *   • `logger` (set by the tracing middleware);
 *   • `req.path` (used to early-return on `/v1/auth/*` pre-auth routes).
 *
 * Writes a 404 Problem Details `Response` only on the refusal path;
 * happy/fail-open paths just call `next()`.
 */
export interface TenantClaimGuardContext {
  readonly req: {
    readonly path: string;
  };
  get(key: 'tenantSlug'): string | undefined;
  get(key: 'authClaims'): { studioId: string; userId?: string; role?: string } | undefined;
  get(key: 'traceId'): string;
  get(key: 'logger'): { warn: (msg: string, ctx?: Record<string, unknown>) => void } | undefined;
  body(data: string, status: 404, headers: Record<string, string>): Response;
}

/**
 * Options for {@link tenantClaimGuard}.
 */
export interface TenantClaimGuardOptions {
  /**
   * REQUIRED — given a slug, return the matching `studios.id` or
   * `null`. Errors thrown by this resolver trigger fail-open
   * (the guard logs `warn` and lets the request through; the
   * downstream JWT claim-based filtering still enforces tenant
   * isolation).
   */
  readonly resolveStudioBySlug: StudioSlugResolver;

  /**
   * Cache TTL in milliseconds. Defaults to 60 s.
   */
  readonly cacheTtlMs?: number;

  /**
   * Stable cache namespace — typically `env.DB_URL`, so two distinct
   * envs sharing one isolate (preview deploys) never see each
   * other's slug→studioId mapping.
   */
  readonly cacheNamespace: string;

  /**
   * Path prefixes that bypass the cross-check entirely. Defaults
   * to `['/v1/auth/']` because those endpoints (login, register,
   * refresh) run pre-auth: the JWT claim is not yet present, so a
   * cross-check would always be a no-op or a false 404.
   *
   * Each entry is matched as a strict prefix (e.g. `/v1/auth/`
   * matches `/v1/auth/login` but NOT `/v1/authentic`).
   */
  readonly bypassPrefixes?: readonly string[];
}

/**
 * Hono-compatible middleware signature for the cross-check. Returns
 * `Promise<Response | void>` because the refusal path
 * short-circuits with a 404 Problem Details Response; the happy and
 * fail-open paths return `void` after awaiting `next()`.
 */
export type TenantClaimGuardMiddleware = (
  c: TenantClaimGuardContext,
  next: () => Promise<void>,
) => Promise<Response | void>;

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/**
 * Build the slug ↔ JWT `studio` cross-check middleware.
 *
 * Behaviour per request:
 *
 *   1. If the request path matches any of {@link TenantClaimGuardOptions.bypassPrefixes}
 *      (default `['/v1/auth/']`), call `next()` immediately. Pre-auth
 *      routes have no `studioId` claim to compare against; mounting
 *      this guard ahead of auth would otherwise trigger 404s on
 *      legitimate registration/login flows.
 *   2. Read `tenantSlug` and `authClaims.studioId` from the context.
 *      • If `tenantSlug` is `undefined` (apex host, IP, dev local),
 *        skip the check — the resolver explicitly designed `'none'`
 *        as a legitimate state for the mobile API on `api.athlya.app`.
 *      • If `authClaims` is `undefined` (route declared public —
 *        e.g. `/health`, `/.well-known/jwks.json` if mounted under
 *        `/v1/*` — or the auth middleware decided not to challenge),
 *        skip the check — there is no claim to cross-reference.
 *   3. Look up the slug in the cache. On miss, call
 *      `resolveStudioBySlug(slug)` and cache the result for the
 *      configured TTL.
 *   4. If the cached/resolved `studioId` is `null` (slug unknown to
 *      this DB) OR differs from `authClaims.studioId`, refuse the
 *      request with a **404** Problem Details body. We deliberately
 *      use 404 rather than 403 to avoid leaking the existence of
 *      another tenant — the response is indistinguishable from a
 *      legitimate "no such resource" to an attacker probing host
 *      headers.
 *   5. On a successful match, fall through to `next()`.
 *
 * Fail-open policy
 * ----------------
 * If `resolveStudioBySlug` throws (typically a transient DB outage),
 * the guard logs a structured `warn` line via `c.get('logger')` and
 * lets the request through. Tenant isolation is still enforced
 * downstream by the JWT `studio` claim (every domain repo filters
 * queries on `studioId` from `authClaims`, and RLS forces the same
 * boundary at the SQL layer). The host-vs-claim mismatch is an
 * additional defense-in-depth surface, not the primary boundary —
 * choosing fail-open over fail-closed prevents a DB outage from
 * cascading into a global 5xx storm. This mirrors the rate-limit
 * fail-open policy documented in `worker.ts` (Slice 1.1).
 *
 * Performance
 * -----------
 * Hot path: 1 cache hit (Map.get) + 1 string equality check.
 * Cold path: 1 cache miss + 1 SELECT-by-unique-index. The 60-second
 * TTL absorbs burst traffic — at 1k rps per slug, the steady-state
 * load on the `studios` table is 1 query / 60 s / slug.
 */
export function tenantClaimGuard(options: TenantClaimGuardOptions): TenantClaimGuardMiddleware {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_TENANT_CACHE_TTL_MS;
  const bypassPrefixes = options.bypassPrefixes ?? ['/v1/auth/'];
  const namespace = options.cacheNamespace;

  return async (c, next) => {
    // 1. Bypass list — pre-auth routes have no claim to compare.
    const path = c.req.path;
    for (const prefix of bypassPrefixes) {
      if (path.startsWith(prefix)) {
        await next();
        return;
      }
    }

    // 2. Skip when there is nothing to cross-check.
    const slug = c.get('tenantSlug');
    const claims = c.get('authClaims');
    if (slug === undefined || claims === undefined) {
      await next();
      return;
    }

    // 3. Cache lookup with fail-open on resolver errors.
    const key = cacheKey(namespace, slug);
    const now = Date.now();
    const cached = tenantSlugCache.get(key);
    let studioId: string | null;
    if (cached !== undefined && cached.expiresAt > now) {
      studioId = cached.studioId;
    } else {
      try {
        studioId = await options.resolveStudioBySlug(slug);
        tenantSlugCache.set(key, {
          studioId,
          expiresAt: now + ttlMs,
        });
      } catch (err) {
        // DB unreachable — fail open. The downstream claim-
        // based filtering still enforces tenant isolation.
        const logger = c.get('logger');
        logger?.warn('tenant claim guard: studio lookup failed, failing open', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
        await next();
        return;
      }
    }

    // 4. Mismatch (or unknown slug) → 404 Problem Details. Never
    //    403: the absence of leak is the whole point of this code.
    if (studioId === null || studioId !== claims.studioId) {
      const traceId = c.get('traceId');
      const body = JSON.stringify({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: TENANT_MISMATCH_CODE,
        traceId,
      });
      return c.body(body, 404, {
        'content-type': PROBLEM_JSON,
      });
    }

    // 5. Match — proceed.
    await next();
    return;
  };
}
