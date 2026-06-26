/**
 * JWT authentication middleware (task 8.2).
 *
 * Verifies `Authorization: Bearer <jwt>` against the current JWKS
 * published by the Auth service, then projects the validated claims
 * into the Hono request context so downstream middleware and domain
 * handlers can read `userId`, `studioId` and `role` without re-parsing
 * the token.
 *
 * Satisfies Requirements 2.5 and 14.1:
 *
 *   • 14.1 — The API_Gateway SHALL verify the JWT RS256 signature
 *            against the current JWKS before invoking any domain
 *            service.
 *   • 2.5  — When an access token expires during an authenticated
 *            session, THE API_Gateway SHALL respond with HTTP 401
 *            and the header `WWW-Authenticate: Bearer
 *            error="token_expired"`.
 *
 * Error envelopes follow the same RFC 9457 Problem Details shape that
 * `worker.ts` already emits on 404/500 (`{ type, title, status,
 * traceId }`, `content-type: application/problem+json`). The four
 * 401 variants are:
 *
 *   - `missing_authorization` — no `Authorization` header present.
 *   - `invalid_token`         — malformed header, malformed JWS,
 *                               signature failure, wrong `kid`, wrong
 *                               `alg`, missing required claims.
 *   - `token_expired`         — `jose` threw `JWTExpired`. This path
 *                               additionally sets
 *                               `WWW-Authenticate: Bearer
 *                               error="token_expired"` per Req 2.5.
 *
 * Why framework-free?
 * -------------------
 * Like `security-headers.ts`, this middleware keeps `hono` as a peer
 * dependency only. The `JwtAuthContext` interface below duck-types
 * the minimal Hono surface we need (`req.header`, `set`, `header`,
 * `json`, `env`, `get`), so the middleware drops into a Hono app via
 * `app.use('/v1/*', jwtAuth())` without importing Hono types.
 * Selective wiring onto authenticated route groups is owned by task
 * 8.11 — this module intentionally does NOT touch `worker.ts`.
 *
 * JWKS caching
 * ------------
 * `jose.createRemoteJWKSet` maintains its own in-memory cache with
 * configurable `cooldownDuration` (default 30 s) and `cacheMaxAge`
 * (default 10 min). We build exactly one getter per
 * `JWT_JWKS_URL` value and stash it in a module-scope `Map`, so every
 * request reuses the same getter instance and therefore the same
 * cache. Ten minutes matches the task brief and the Worker isolate
 * lifetime (Cloudflare isolates are re-used across requests for
 * ~minutes under steady load).
 *
 * Upstream: consumed by route groups mounted by task 8.11.
 * Downstream: feeds `authClaims` and the re-scoped `logger` into
 * `AthlyaVariables` so middleware 8.3 (tenant resolver) and 8.4
 * (rate limiter) can read the verified identity without re-parsing
 * the JWT.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

import { createLogger } from '../logging.js';

import type { AthlyaBindings } from '../types.js';
import type { FlattenedJWSInput, JWSHeaderParameters, JWTPayload } from 'jose';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Problem Details content-type per RFC 9457. Same value `worker.ts` emits. */
const PROBLEM_JSON = 'application/problem+json';

/** Signing algorithm pinned by the Auth service. Matches `@athlya/auth/jwt`. */
const ALLOWED_ALGORITHMS = ['RS256'] as const;

/** Case-insensitive match for `Bearer <token>`; the capture group is the token. */
const BEARER_RE = /^\s*Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/u;

/** Closed set of roles accepted in the `role` claim. */
const VALID_ROLES = new Set<AuthClaims['role']>(['member', 'admin', 'coach']);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Verified claims written onto the Hono context as `authClaims`.
 *
 * `userId` is the `sub` claim, `studioId` is the `studio` claim and
 * `role` is the closed union `'member' | 'admin' | 'coach'`. Any JWT
 * whose `role` is not one of these three values is rejected with a
 * generic `invalid_token` to avoid leaking the closed set to
 * attackers.
 */
export interface AuthClaims {
  userId: string;
  studioId: string;
  role: 'member' | 'admin' | 'coach';
}

/**
 * Minimal context shape accepted by {@link jwtAuth}. The live Hono
 * `Context<HonoEnv>` satisfies this interface structurally, so the
 * middleware drops into a Hono app without a cast. The same shape is
 * also trivially implementable in tests so we avoid spinning up a
 * full Hono pipeline for unit-level assertions.
 */
export interface JwtAuthContext {
  readonly env: AthlyaBindings;
  readonly req: {
    header(name: string): string | undefined;
  };
  get(key: 'traceId'): string;
  get(key: 'logger' | 'authClaims' | 'startedAt'): unknown;
  set(key: 'logger', value: ReturnType<typeof createLogger>): void;
  set(key: 'authClaims', value: AuthClaims): void;
  header(name: string, value: string): void;
  body(data: string, status: 401, headers: Record<string, string>): Response;
}

/** Hono-compatible middleware signature, typed minimally. */
export type JwtAuthMiddleware = (
  c: JwtAuthContext,
  next: () => Promise<void>,
) => Promise<Response | void>;

/* ------------------------------------------------------------------ */
/*  JWKS cache                                                         */
/* ------------------------------------------------------------------ */

/**
 * JWKS cache max-age (10 minutes). Matches the task brief. Explicit
 * so any future change is visible at a glance and so tests can reason
 * about the staleness window.
 */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;

/**
 * JWKS cooldown between refetches on cache miss. `jose` defaults to
 * 30 seconds; we codify the number here for documentation.
 */
const JWKS_COOLDOWN_MS = 30 * 1_000;

/**
 * Type of the key resolver accepted by `jose.jwtVerify`. Declared
 * here rather than re-exported so downstream code never has to depend
 * on `jose`'s internal signature.
 *
 * The live production value is `createRemoteJWKSet(new URL(...))`
 * which matches this shape; tests inject a synchronous lookup over
 * an in-memory key set so no network I/O happens.
 */
export type JwksKeyResolver = (
  protectedHeader?: JWSHeaderParameters,
  token?: FlattenedJWSInput,
) => Promise<CryptoKey>;

/**
 * One getter per distinct `JWT_JWKS_URL`. Keeping this in module
 * scope (not inside the factory) means every `jwtAuth()` instance
 * across the worker isolate shares the same cache, which is the
 * whole point of using `createRemoteJWKSet` over a hand-rolled cache.
 *
 * The key is the raw URL string; callers typically point a whole
 * deployment at one URL, so the map usually holds exactly one entry.
 */
const jwksGetters = new Map<string, JwksKeyResolver>();

/**
 * Return the cached JWKS getter for `url`, creating one on first use.
 *
 * The URL is not validated here beyond what `new URL(...)` does —
 * `JWT_JWKS_URL` comes from `wrangler.toml`/secrets and is treated as
 * trusted configuration. A runtime `TypeError` from `new URL` bubbles
 * to the caller as a 500 via the gateway's global error handler,
 * which is the right outcome: a misconfigured secret is an ops
 * incident, not an auth failure.
 */
function getDefaultJwksResolver(url: string): JwksKeyResolver {
  const cached = jwksGetters.get(url);
  if (cached !== undefined) {
    return cached;
  }
  const getter = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  });
  jwksGetters.set(url, getter);
  return getter;
}

/**
 * Reset the in-memory JWKS cache. Test-only hook — production code
 * has no reason to clear the cache explicitly. Exported under the
 * `__` prefix so it is obviously internal.
 */
export function __resetJwksCacheForTests(): void {
  jwksGetters.clear();
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Problem Details envelope matching the shape `worker.ts` emits. The
 * `type` is `about:blank` for parity with the existing 404/500 paths;
 * task 8.5 will lift the full RFC 9457 catalogue (including studio-
 * specific `type` URIs under `https://athlya.app/problems/*`) into a
 * shared helper, at which point this builder will be updated too.
 */
interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: 401;
  readonly traceId: string;
}

/** Build a Problem Details body with `title` as the short error code. */
function problem(title: string, traceId: string): ProblemDetails {
  return { type: 'about:blank', title, status: 401, traceId };
}

/**
 * Emit a 401 Problem Details response.
 *
 * - Always sets `content-type: application/problem+json` via the
 *   `c.body(...)` init bag. Using `c.body` rather than `c.json` keeps
 *   the content-type pinned — Hono's `c.json` would otherwise
 *   re-stamp `application/json` on the response, clobbering the
 *   Problem Details content-type.
 * - Optionally sets `WWW-Authenticate: Bearer error="<code>"` so
 *   `token_expired` callers get the RFC 6750 challenge header that
 *   Req 2.5 mandates. When `wwwAuthenticateError` is `undefined` no
 *   such header is emitted — missing-auth and invalid-token responses
 *   intentionally omit it so clients do not conflate "no credentials"
 *   with "credentials expired".
 */
function respond401(
  c: JwtAuthContext,
  code: 'missing_authorization' | 'invalid_token' | 'token_expired',
  wwwAuthenticateError?: 'token_expired',
): Response {
  const headers: Record<string, string> = {
    'content-type': PROBLEM_JSON,
  };
  if (wwwAuthenticateError !== undefined) {
    headers['WWW-Authenticate'] = `Bearer error="${wwwAuthenticateError}"`;
  }
  return c.body(JSON.stringify(problem(code, c.get('traceId'))), 401, headers);
}

/* ------------------------------------------------------------------ */
/*  Claim narrowing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Narrow the verified `JWTPayload` into our {@link AuthClaims} shape.
 * Returns `null` when any required claim is missing or has the wrong
 * shape, leaving the caller to emit a generic `invalid_token`
 * response — we deliberately do NOT report which claim was missing,
 * so attackers cannot probe the expected claim set via 401 bodies.
 */
function extractClaims(payload: JWTPayload): AuthClaims | null {
  const sub = payload.sub;
  const studio = payload['studio'];
  const role = payload['role'];

  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof studio !== 'string' || studio.length === 0) return null;
  if (typeof role !== 'string') return null;

  if (!VALID_ROLES.has(role as AuthClaims['role'])) return null;

  return {
    userId: sub,
    studioId: studio,
    role: role as AuthClaims['role'],
  };
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Options for {@link jwtAuth}. Every field is optional; defaults
 * match the Auth service's issuer and audience conventions.
 *
 * In production these come straight from the environment — we do
 * NOT overload `AthlyaBindings` with auth-specific configuration
 * because the JWKS URL is already there and the issuer / audience
 * pair is deployment-stable (not a secret, not per-tenant).
 */
export interface JwtAuthOptions {
  /**
   * Expected `iss` claim. When set, tokens whose `iss` does not
   * match are rejected with `invalid_token`. Default: unset (any
   * `iss` accepted by `jose`'s default).
   */
  issuer?: string;

  /**
   * Expected `aud` claim. When set, tokens whose `aud` does not
   * match are rejected with `invalid_token`. Default: unset.
   */
  audience?: string;

  /**
   * Clock skew tolerance in seconds. Default: 0 (tight). Useful in
   * tests that freeze time via an injected clock.
   */
  clockToleranceSec?: number;

  /**
   * JWKS key resolver override. Defaults to a module-cached
   * {@link createRemoteJWKSet} keyed on `env.JWT_JWKS_URL`. Tests
   * inject a synchronous resolver backed by a local key set so the
   * middleware never performs network I/O — the production path
   * (`createRemoteJWKSet`) is covered by the `jose` test suite and
   * by task 8.12's integration tests.
   */
  keyResolver?: JwksKeyResolver;
}

/**
 * Build the auth middleware.
 *
 * Behaviour — see module doc for the full rationale:
 *
 *   1. No `Authorization` header → 401 `missing_authorization` (no
 *      `WWW-Authenticate` header).
 *   2. Header not `Bearer <token>` → 401 `invalid_token`.
 *   3. `jose.jwtVerify` throws `JWTExpired` → 401 `token_expired` +
 *      `WWW-Authenticate: Bearer error="token_expired"`.
 *   4. Any other `jose` error (bad sig, wrong `kid`, wrong `alg`,
 *      malformed JWS, claim validation failure including bad
 *      `iss`/`aud`) → 401 `invalid_token`.
 *   5. Required claims (`sub`, `studio`, valid `role`) missing →
 *      401 `invalid_token`.
 *   6. Success → `c.set('authClaims', ...)`, re-scope `c.get('logger')`
 *      to carry `userId`/`studioId`, then `await next()`.
 *
 * Slice 1.5 (Sprint 1 — SP1.6, audit finding S2-005): when no
 * explicit `options.issuer` / `options.audience` are passed, the
 * middleware derives the expected values from {@link AthlyaBindings}
 * at request time:
 *
 *   - `issuer`   ← `c.env.JWT_ISSUER ?? 'athlya'`
 *   - `audience` ← `c.env.JWT_AUDIENCE ?? \`athlya-api-${c.env.ENVIRONMENT}\``
 *
 * This stops a token issued by another Athlya service (or any third
 * party that ever shares our JWKS) from landing on the gateway —
 * the cross-service confused-deputy defence S2-005 calls for.
 */
export function jwtAuth(options: JwtAuthOptions = {}): JwtAuthMiddleware {
  return async (c, next) => {
    const traceId = c.get('traceId');

    // Step 1 — header presence.
    const authz = c.req.header('Authorization');
    if (authz === undefined || authz === null || authz.length === 0) {
      return respond401(c, 'missing_authorization');
    }

    // Step 2 — parse the Bearer envelope.
    const match = BEARER_RE.exec(authz);
    const token = match?.[1];
    if (token === undefined) {
      return respond401(c, 'invalid_token');
    }

    // Slice 1.5 — derive iss/aud defaults from the live bindings
    // when the caller did not pass explicit values. Reading at
    // request-time (rather than middleware-build-time) keeps the
    // factory env-agnostic, which matters for tests that build
    // the middleware once and exercise it against multiple env
    // overrides.
    const expectedIssuer = options.issuer ?? c.env.JWT_ISSUER ?? 'athlya';
    const expectedAudience =
      options.audience ?? c.env.JWT_AUDIENCE ?? `athlya-api-${c.env.ENVIRONMENT}`;

    // Step 3 — verify against the cached JWKS.
    const getKey = options.keyResolver ?? getDefaultJwksResolver(c.env.JWT_JWKS_URL);
    let payload: JWTPayload;
    const jwtVerifyStart = Date.now();
    try {
      const verifyOpts: Parameters<typeof jwtVerify>[2] = {
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: options.clockToleranceSec ?? 0,
        issuer: expectedIssuer,
        audience: expectedAudience,
      };

      const result = await jwtVerify(token, getKey, verifyOpts);
      payload = result.payload;
    } catch (err) {
      // Expired tokens are the single case that gets its own
      // wire-level error code + WWW-Authenticate challenge.
      if (err instanceof joseErrors.JWTExpired) {
        return respond401(c, 'token_expired', 'token_expired');
      }
      // Everything else (bad signature, wrong kid, wrong alg,
      // malformed JWS, bad iss/aud) collapses to a single
      // `invalid_token` code. The `jose` error's own `.code` is
      // NOT exposed to the caller so attackers can't
      // fingerprint the verification path.
      return respond401(c, 'invalid_token');
    }

    const jwtVerifyMs = Date.now() - jwtVerifyStart;
    if (jwtVerifyMs >= 15) {
      console.warn(JSON.stringify({ msg: 'athlya.auth.jwt_verify_slow', jwtVerifyMs, traceId }));
    }

    // Step 4 — extract canonical claims.
    const claims = extractClaims(payload);
    if (claims === null) {
      return respond401(c, 'invalid_token');
    }

    // Step 5 — inject claims + re-scope the logger so every line
    // after auth carries the authenticated identity. We rebuild
    // the logger from scratch because `createLogger` does not
    // expose a `child()` API — the base fields are captured in a
    // closure and there is no merge path on the returned
    // `StructuredLogger`. Rebuilding is cheap (one object spread).
    c.set('authClaims', claims);
    c.set(
      'logger',
      createLogger({
        traceId,
        env: c.env.ENVIRONMENT,
        userId: claims.userId,
        studioId: claims.studioId,
      }),
    );

    await next();
    return;
  };
}
