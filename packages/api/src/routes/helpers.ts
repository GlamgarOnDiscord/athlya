/**
 * Shared helpers for the `/v1/*` domain routers (task 8.11).
 *
 * Keeps common plumbing out of every sibling route module:
 *
 *   • {@link projectUserIdFromClaims} — middleware that copies the
 *     verified `authClaims.userId` onto the context key the
 *     idempotency middleware looks up (`c.get('userId')`). Keeps the
 *     idempotency middleware ignorant of the auth claim shape.
 *   • {@link requireRole} — guard that rejects requests whose
 *     authenticated role is not in a whitelist with a 403 Problem
 *     Details envelope.
 *   • {@link problem403} — Problem Details builder for 403 bodies.
 *   • {@link readValidated} — typed reader for payloads written onto
 *     the context by `zValidator`.
 */

import { can, rolesWith } from '@athlya/shared/roles';

import { idempotencyMiddleware as rawIdempotencyMiddleware } from '../middleware/idempotency.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { ValidationTarget } from '../middleware/validator.js';
import type { HonoEnv } from '../types.js';
import type { Capability } from '@athlya/shared/roles';
import type { Context, MiddlewareHandler } from 'hono';

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/* ------------------------------------------------------------------ */
/*  userId projection                                                  */
/* ------------------------------------------------------------------ */

/**
 * Copy `authClaims.userId` onto the legacy `userId` context key read
 * by {@link import('../middleware/idempotency.js').idempotencyMiddleware}.
 *
 * This middleware is a no-op when `authClaims` is absent (the route
 * is public or the auth middleware has not run yet). Authenticated
 * routes MUST mount it AFTER `jwtAuth()` and BEFORE
 * `idempotencyMiddleware(...)`.
 */
export function projectUserIdFromClaims(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const claims = c.get('authClaims');
    if (claims !== undefined) {
      // The Hono context slot key is deliberately a free-form
      // string — `userId` is not declared on AthlyaVariables
      // because no existing middleware writes it. The
      // idempotency middleware reads it via `c.get('userId')`
      // (see `middleware/idempotency.ts`).
      (c as unknown as { set: (key: string, value: unknown) => void }).set('userId', claims.userId);
    }
    await next();
  };
}

/* ------------------------------------------------------------------ */
/*  Role guard                                                         */
/* ------------------------------------------------------------------ */

/**
 * Problem Details envelope emitted on a 403 forbidden response.
 *
 * `title` is the short error code, matching the convention the
 * sibling 401 paths use in `middleware/auth.ts` pending the full RFC
 * 9457 catalogue lift by task 8.5.
 */
export interface ForbiddenProblem {
  readonly type: 'about:blank';
  readonly title: 'forbidden';
  readonly status: 403;
  readonly traceId: string;
  readonly detail: string;
}

/**
 * Build a 403 Problem Details response.
 *
 * Used by the admin-only / coach-only guards on routes like
 * `POST /v1/classes` (Req 6.5) and `GET /v1/members` (Req 3.5).
 */
export function problem403(c: Context<HonoEnv>, detail: string): Response {
  const body: ForbiddenProblem = {
    type: 'about:blank',
    title: 'forbidden',
    status: 403,
    traceId: c.get('traceId'),
    detail,
  };
  return c.body(JSON.stringify(body), 403, {
    'content-type': PROBLEM_JSON,
  });
}

/**
 * Middleware that rejects authenticated requests whose `role` is not
 * in `allowed` with a 403 Problem Details envelope. Mounts AFTER
 * {@link import('../middleware/auth.js').jwtAuth}.
 *
 * When `authClaims` is absent (programmer error — auth middleware
 * not mounted), the guard responds 403 conservatively rather than
 * silently letting the request through.
 */
export function requireRole(
  ...allowed: ReadonlyArray<AuthClaims['role']>
): MiddlewareHandler<HonoEnv> {
  const set = new Set(allowed);
  return async (c, next) => {
    const claims = c.get('authClaims');
    if (claims === undefined || !set.has(claims.role)) {
      return problem403(c, `this endpoint requires one of: ${[...set].join(', ')}`);
    }
    await next();
    return;
  };
}

/**
 * Middleware that rejects authenticated requests whose role holds none
 * of `capabilities` in the studio capability matrix
 * (`@athlya/shared/roles`, issue #756), with the same 403 envelope as
 * {@link requireRole}. Mounts AFTER `jwtAuth`.
 */
export function requireCapability(
  ...capabilities: readonly [Capability, ...Capability[]]
): MiddlewareHandler<HonoEnv> {
  const roles = [...new Set(capabilities.flatMap((cap) => rolesWith(cap)))];
  return async (c, next) => {
    const claims = c.get('authClaims');
    if (claims === undefined || !capabilities.some((cap) => can(claims.role, cap))) {
      return problem403(c, `this endpoint requires one of: ${roles.join(', ')}`);
    }
    await next();
    return;
  };
}

/* ------------------------------------------------------------------ */
/*  Validated payload reader                                           */
/* ------------------------------------------------------------------ */

/**
 * Read a payload that {@link import('../middleware/validator.js').zValidator}
 * wrote onto the context under the key returned by
 * {@link validatedContextKey}`(target)`.
 *
 * The Hono-level key is a free-form string (see `validator.ts`), so
 * it is not part of the {@link HonoEnv} surface and needs a narrow
 * cast at the read site. Centralising the cast here keeps the route
 * handlers type-clean.
 */
export function readValidated<T>(c: Context<HonoEnv>, target: ValidationTarget): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get(`validated:${target}`) as T;
}

/* ------------------------------------------------------------------ */
/*  Idempotency wrapper                                                */
/* ------------------------------------------------------------------ */

/**
 * Wrap the upstream {@link rawIdempotencyMiddleware} into a
 * {@link MiddlewareHandler}<{@link HonoEnv}>-typed value.
 *
 * The upstream type is parameterised on a dedicated `IdempotencyEnv`
 * whose `Variables` shape requires a top-level `userId: string`
 * field. The gateway's shared {@link HonoEnv} does NOT declare that
 * field (the auth middleware writes `authClaims` instead), which is
 * why every route must compose `projectUserIdFromClaims()` ahead of
 * idempotency.
 *
 * A direct return type mismatch surfaces at every call site as a
 * Hono overload error — the two Hono `MiddlewareHandler` generics
 * are not mutually assignable. This wrapper bridges the gap with a
 * single localised cast, keeping every route handler's chain clean
 * of casts.
 */
export function idempotency(deps: IdempotencyMiddlewareDeps): MiddlewareHandler<HonoEnv> {
  // `rawIdempotencyMiddleware` is typed against its own
  // `IdempotencyEnv`; at runtime both environments share the same
  // Hono bindings and the reads are identical — only the type
  // parameter differs. Cast through `unknown` per TypeScript
  // convention for narrow, intentional bridges between otherwise-
  // compatible generic types.
  return rawIdempotencyMiddleware(deps) as unknown as MiddlewareHandler<HonoEnv>;
}

/* ------------------------------------------------------------------ */
/*  Client IP derivation (Sprint-1 SP1.2)                              */
/* ------------------------------------------------------------------ */

/** Stable bucket used when no client IP can be derived from headers. */
const UNKNOWN_IP_BUCKET = 'unknown';

/**
 * Resolve the client IP from CF-aware headers, falling back to a
 * stable sentinel so the limiter never receives an empty key.
 *
 * Precedence:
 *   1. `CF-Connecting-IP` — set by Cloudflare's edge.
 *   2. First token of `X-Forwarded-For` — local dev or non-CF deploys.
 *   3. Sentinel `'unknown'` — every header-stripping client lands here.
 *
 * Mirrors the precedence used by `middleware/rate-limit.ts` so login
 * throttle buckets and the global IP limiter use the same definition
 * of "client IP". Whitespace-only headers are treated as absent so a
 * misbehaving proxy cannot split a bucket.
 */
export function deriveClientIp(
  cfConnectingIp: string | undefined,
  xForwardedFor: string | undefined,
): string {
  if (cfConnectingIp !== undefined) {
    const trimmed = cfConnectingIp.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (xForwardedFor !== undefined) {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  return UNKNOWN_IP_BUCKET;
}

/* ------------------------------------------------------------------ */
/*  ETag computation (B5.1, B5.2)                                      */
/* ------------------------------------------------------------------ */

/**
 * Compute a strong ETag (RFC 7232 §2.3.1) from a fingerprint string.
 *
 * Backed by Web Crypto's `SHA-256` digest — available natively in
 * Cloudflare Workers, Node 22+ and modern browsers, so no polyfill
 * is needed. We truncate the hex digest to 16 characters (64 bits)
 * which is far above the birthday-collision threshold for any
 * realistic listing size while keeping the response header tiny.
 *
 * The returned value is wrapped in `"…"` so it is ready to feed
 * straight into `c.header('etag', …)` and the `If-None-Match`
 * comparison without further normalisation.
 *
 * Used by:
 *   • B5.1 — `GET /v1/classes` listing handler.
 *   • B5.2 — `GET /v1/reservations/me` listing handler.
 *
 * The caller chooses the fingerprint shape, typically by joining
 * `(id, version, mutable-fields)` triples with a separator that
 * cannot appear in any of the field values (we use `|` and `:`
 * which are safe for UUIDs and ISO-8601 timestamps).
 */
export async function computeListEtag(fingerprint: string): Promise<string> {
  const data = new TextEncoder().encode(fingerprint);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `"${hex.slice(0, 16)}"`;
}

/**
 * Sprint 12 / Slice 12.9 (Epic B7.3) — name the request span with a
 * `<verb>.<domain>` flavour (e.g. `auth.login`, `reservations.book`)
 * so the OTel backend (Axiom) groups spans by business operation
 * rather than by HTTP route template.
 *
 * Idempotent and safe to call from any handler — the underlying
 * {@link import('../middleware/otel.js').TraceSpan} writer ignores
 * post-end calls. When the OTel middleware is not mounted (e.g.
 * route-level unit tests), the no-op fallback avoids a crash.
 *
 * Sprint 12 / Slice 12.10 (Epic B7.2) — also stamps the
 * `breadcrumb.operation.start` span event so a 5xx capture later
 * lifts the operation chain into Sentry's `extra.breadcrumbs`.
 *
 * Usage:
 *
 *     router.post('/', projectUserIdFromClaims(), zValidator(...), async (c) => {
 *         traceOperation(c, 'reservations.book');
 *         // …
 *     });
 */
export function traceOperation(c: Context<HonoEnv>, operation: string): void {
  const span = c.get('span');
  if (span === undefined) return;
  if (typeof (span as { setName?: unknown }).setName === 'function') {
    (span as { setName: (n: string) => void }).setName(operation);
  }
  if (typeof (span as { addEvent?: unknown }).addEvent === 'function') {
    (
      span as {
        addEvent: (name: string, attrs?: Record<string, unknown>) => void;
      }
    ).addEvent('breadcrumb.operation.start', { operation });
  }
}

/**
 * Sprint 12 / Slice 12.10 (Epic B7.2) — record a Sentry-style
 * breadcrumb on the OTel span. The breadcrumbs are indexed under
 * `breadcrumb.*` event names so the 5xx capture path can lift them
 * into Sentry's `extra.breadcrumbs` field at error time.
 *
 * Idempotent and PII-safe: the caller is responsible for sanitising
 * `data` (e.g. drop password / token / email fields). The helper
 * itself enforces a 1KB limit on the JSON-stringified data so a
 * thoughtless `addBreadcrumb(c, 'x', { user })` cannot exfiltrate
 * the entire user record.
 *
 * Categories follow Sentry's convention: `'auth' | 'http' |
 * 'navigation' | 'query' | 'ui' | 'default'` are typical. The
 * helper accepts any string so domain handlers stay flexible.
 *
 * Usage:
 *
 *     addBreadcrumb(c, 'reservations.lock_acquired', {
 *         classId,
 *         remaining,
 *     });
 */
export function addBreadcrumb(
  c: Context<HonoEnv>,
  message: string,
  data?: Record<string, unknown>,
): void {
  const span = c.get('span');
  if (span === undefined) return;
  if (typeof (span as { addEvent?: unknown }).addEvent !== 'function') {
    return;
  }
  let safeData: Record<string, unknown> | undefined;
  if (data !== undefined) {
    try {
      const serialised = JSON.stringify(data);
      // Cap at 1024 bytes to keep one breadcrumb from blowing
      // up the OTel envelope. Stripe's SDK uses 1500; we are
      // tighter because Workers have a 1 MiB request budget.
      if (serialised.length <= 1024) {
        safeData = data;
      } else {
        safeData = {
          truncated: true,
          bytes: serialised.length,
        };
      }
    } catch {
      // Circular reference — skip the data altogether.
      safeData = { unserialisable: true };
    }
  }
  const eventName = `breadcrumb.${message}`;
  (
    span as {
      addEvent: (name: string, attrs?: Record<string, unknown>) => void;
    }
  ).addEvent(eventName, safeData !== undefined ? safeData : undefined);
}
