/**
 * Problem Details error mapper and global `onError` wiring (task 8.5).
 *
 * Satisfies Requirements 14.2 and 14.6:
 *
 *   • 14.2 — Every route validates its payload against the shared
 *            Zod schemas (task 1.3). A rejection here is converted
 *            to HTTP 422 with a machine-readable body so clients
 *            can surface field-level diagnostics to the user.
 *   • 14.6 — Any thrown error is converted into
 *            `application/problem+json` per RFC 9457, carrying at
 *            minimum `type`, `title`, `status` and `traceId`. The
 *            mapping table below is ordered by priority — the first
 *            `instanceof` match wins.
 *
 * Architecture — why split mapper and handler?
 * --------------------------------------------
 * Two exports ship from this module:
 *
 *   1. {@link toProblemResponse} — a *pure* function that maps an
 *      unknown error into `{ status, body }`. No HTTP library, no
 *      side effects, no I/O. This is the piece integration tests
 *      and queue-consumer error paths call directly.
 *   2. {@link registerErrorHandlers} — a tiny helper that plugs the
 *      pure mapper into a Hono app via `app.onError(…)`. The helper
 *      is the only point that touches the Hono surface; everything
 *      else in the module is framework-free.
 *
 * Architecture — the secret-leak guard
 * ------------------------------------
 * The fallback branch (unknown `Error` → 500) NEVER copies
 * `err.message` or `err.stack` into the body. Attackers probing the
 * gateway have been known to exfiltrate credentials through badly
 * worded internal errors (a `new Error("db password is <secret>")`
 * thrown from a dependency). We log the full error through the
 * request-scoped logger at `error` level so on-call triage still has
 * the information, but the response body stays generic. Unit tests
 * in `__tests__/problem-details.test.ts` exercise this invariant
 * with a deliberately sensitive marker.
 *
 * Priority order of the `instanceof` table:
 *
 *   1. {@link ValidationError} (task 8.5) → 422.
 *   2. {@link MissingAuthClaimsError} (task 8.3) → 401.
 *   3. {@link TenantResourceNotFoundError} (task 8.3) → 404, via
 *      {@link tenantErrorToProblem}.
 *   4. Fallback (`Error` / `unknown`) → 500 with `about:blank` and
 *      no `err.message`/`err.stack` leaked to the body.
 *
 * Future errors (rate limit, shared-error classes from
 * `@athlya/shared/errors`, domain-layer errors from
 * `@athlya/reservations`) can be added by inserting a branch at the
 * correct priority level. Keep the table ordered by specificity —
 * the first match wins.
 */

import {
  MissingAuthClaimsError,
  TenantResourceNotFoundError,
  tenantErrorToProblem,
} from './tenant.js';
import { ValidationError } from './validator.js';

import type { ZodIssue } from './validator.js';
import type { AuthErrorCode } from '@athlya/auth';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Problem Details `type` URI prefix under the Athlya namespace.
 *
 * RFC 9457 §3 recommends a dereferenceable URI identifying the error
 * class. Anchoring every Athlya-specific `type` under
 * `https://athlya.app/problems/` makes it trivial to publish a
 * catalogue page describing each slug to API consumers.
 */
const ATHLYA_PROBLEM_NAMESPACE = 'https://athlya.app/problems/';

/** `type` URI for validation failures. */
const VALIDATION_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}validation-error`;

/** `type` URI for authentication failures. */
const UNAUTHENTICATED_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}unauthenticated`;

/** `type` URI for auth-domain semantic failures (422 bucket). */
const AUTH_SEMANTIC_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}auth-error`;

/** `type` URI for 429 rate-limited responses. */
const RATE_LIMITED_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}rate-limited`;

/** `type` URI for 404 not-found responses emitted by the auth domain. */
const NOT_FOUND_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}not-found`;

/** RFC 9457 content-type. */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/* ------------------------------------------------------------------ */
/*  Body shapes                                                        */
/* ------------------------------------------------------------------ */

/**
 * One field-level validation error emitted alongside a 422 body.
 *
 * Mirrors the shape of `ProblemFieldError` from
 * `@athlya/shared/schemas/problem` but adds the Zod `code` so clients
 * can branch on the precise failure kind (e.g. `too_big` vs
 * `invalid_type`) without parsing the human-readable `message`.
 *
 * `path` is a dotted representation of the `ZodIssue.path` array,
 * e.g. `exercises.2.sets.0.reps`. An empty path (root-level failure)
 * is encoded as the empty string.
 */
export interface ProblemFieldError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/**
 * Full Problem Details envelope the mapper emits.
 *
 * All fields are `readonly` so the test suite can freeze the object
 * and detect accidental mutation.
 */
export interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly traceId: string;
  readonly instance?: string;
  readonly errors?: readonly ProblemFieldError[];
}

/**
 * Return value of {@link toProblemResponse}. The `status` field is
 * duplicated at the top level (rather than read from `body.status`)
 * so the Hono integration can pass it straight to
 * `c.body(json, status, headers)` without de-structuring twice.
 */
export interface ProblemResponse {
  readonly status: number;
  readonly body: ProblemDetailsBody;
}

/* ------------------------------------------------------------------ */
/*  Logger contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal logger surface the mapper calls into.
 *
 * A structural subset of {@link import('../logging.js').StructuredLogger}
 * — only `warn` and `error` are referenced, so we declare exactly
 * those here. Duck-typing keeps the module free of a runtime
 * dependency on `logging.ts` (the `import` below is type-only).
 */
export interface ProblemLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Context the pure mapper needs to produce a Problem Details body.
 *
 * `traceId` comes from the per-request scaffolding in `worker.ts`;
 * the logger is the request-scoped one installed by the same
 * middleware. Neither value is optional at runtime — the gateway
 * guarantees both are set before any route handler runs.
 *
 * Sprint 12 / Slice 12.3 (Epic B7.1) — `userId` and `studioId` are
 * optional pass-throughs read from `authClaims` by the gateway when
 * available. Including them in the unhandled-error log line lets
 * on-call triage cut a Sentry/Axiom search by tenant or member
 * without first joining on `traceId` against the audit table.
 * Public routes (where `authClaims` is undefined) leave them out.
 */
export interface ProblemContext {
  readonly traceId: string;
  readonly logger: ProblemLogger;
  /** `userId` from `authClaims`. Logged on 5xx for triage. */
  readonly userId?: string;
  /** `studioId` from `authClaims`. Logged on 5xx for triage. */
  readonly studioId?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a Zod issue `path` (array of string / number / symbol) into
 * a dotted string compatible with {@link ProblemFieldError.path}.
 *
 *   - `[]`                      → `""`
 *   - `["email"]`               → `"email"`
 *   - `["exercises", 2, "sets"]` → `"exercises.2.sets"`
 *   - `[Symbol("x")]`           → `"Symbol(x)"` (defensive — symbols
 *                                 should never appear in JSON paths,
 *                                 but `PropertyKey` includes them).
 *
 * Kept as a free function (not a method on `ValidationError`) so it
 * stays pure and easy to unit-test in isolation.
 */
function formatZodPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  return path
    .map((segment) => {
      if (typeof segment === 'string') return segment;
      if (typeof segment === 'number') return String(segment);
      // Symbol fallback — `.toString()` yields `Symbol(description)`.
      return segment.toString();
    })
    .join('.');
}

/**
 * Project a `ZodIssue` onto the `ProblemFieldError` shape the client
 * receives. Strips every field Zod may emit that is not part of our
 * contract (e.g. `input`, `origin`, `inclusive`) to keep the response
 * surface small and stable.
 */
function toFieldError(issue: ZodIssue): ProblemFieldError {
  return {
    path: formatZodPath(issue.path),
    message: issue.message,
    code: issue.code,
  };
}

/**
 * Build a 422 Problem Details body from a {@link ValidationError}.
 *
 * Extracted so the mapper's main switch stays readable and so the
 * shape can be asserted directly from the unit tests without needing
 * to thread the full {@link ProblemContext} plumbing.
 */
function validationBody(err: ValidationError, traceId: string): ProblemDetailsBody {
  return {
    type: VALIDATION_TYPE,
    title: 'Unprocessable Entity',
    status: 422,
    detail: `validation failed for ${err.target}`,
    code: err.code,
    traceId,
    errors: err.issues.map(toFieldError),
  };
}

/**
 * Build a 401 Problem Details body from a
 * {@link MissingAuthClaimsError}.
 *
 * The middleware layer guarantees this error only fires when a
 * tenant-scoped handler runs without the auth middleware having
 * populated `authClaims` — i.e. either the route is misconfigured or
 * the caller is unauthenticated. Either way, the wire shape is a
 * generic 401 without a `WWW-Authenticate` challenge: that header is
 * owned by `middleware/auth.ts` and only emitted for token-level
 * failures, not for "no credentials at all".
 */
function missingAuthBody(err: MissingAuthClaimsError, traceId: string): ProblemDetailsBody {
  return {
    type: UNAUTHENTICATED_TYPE,
    title: 'Unauthorized',
    status: 401,
    detail: err.message,
    code: err.code,
    traceId,
  };
}

/**
 * Narrow an `unknown` to the shape `AuthError` exposes from
 * `@athlya/auth`. Duck-typed (not an `instanceof` check) so the
 * gateway does NOT carry a runtime dependency on `@athlya/auth` just
 * for the type check — the service is wired via dependency
 * injection in `routes/index.ts` and its error class needs to be
 * recognised here without forcing a cycle.
 *
 * An error is considered an `AuthError` when `name === 'AuthError'`
 * AND `code` is one of the known {@link AuthErrorCode} values. The
 * `name` check keeps us safe against a coincidental `{ code }` shape
 * coming from an unrelated thrown object.
 */
function asAuthError(
  err: unknown,
): { readonly code: AuthErrorCode; readonly details: Readonly<Record<string, unknown>> } | null {
  if (typeof err !== 'object' || err === null) return null;
  const probe = err as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly details?: unknown;
  };
  if (probe.name !== 'AuthError') return null;
  if (typeof probe.code !== 'string') return null;
  switch (probe.code) {
    case 'password_breached':
    case 'hibp_unavailable':
    case 'studio_not_found':
    case 'email_taken':
    case 'invalid_credentials':
    case 'token_invalid':
    case 'token_expired':
    case 'token_revoked':
    case 'oauth_verification_failed':
    case 'rate_limited':
    case 'not_found':
      break;
    default:
      return null;
  }
  const details =
    typeof probe.details === 'object' && probe.details !== null
      ? (probe.details as Readonly<Record<string, unknown>>)
      : {};
  return { code: probe.code, details };
}

/**
 * Map an {@link AuthErrorCode} onto the HTTP status + Problem
 * `type` URI contract documented in `@athlya/auth/service.ts`. Pure
 * lookup table; centralised here so the mapping has a single owner.
 */
function authCodeToStatus(code: AuthErrorCode): {
  readonly status: number;
  readonly type: string;
  readonly title: string;
} {
  switch (code) {
    case 'password_breached':
    case 'studio_not_found':
    case 'email_taken':
      return {
        status: 422,
        type: AUTH_SEMANTIC_TYPE,
        title: 'Unprocessable Entity',
      };
    case 'hibp_unavailable':
      // Sprint-3 SP3.2 (S2-009): HIBP transient outage maps
      // to 503 — semantically a backend dependency failure
      // rather than a user-input problem. Differentiates the
      // wire-level signal from `password_breached` (422) so
      // the client can render a "retry shortly" UI rather
      // than asking the user to change their password.
      return {
        status: 503,
        type: AUTH_SEMANTIC_TYPE,
        title: 'Service Unavailable',
      };
    case 'invalid_credentials':
    case 'token_invalid':
    case 'token_expired':
    case 'token_revoked':
    case 'oauth_verification_failed':
      return {
        status: 401,
        type: UNAUTHENTICATED_TYPE,
        title: 'Unauthorized',
      };
    case 'rate_limited':
      return {
        status: 429,
        type: RATE_LIMITED_TYPE,
        title: 'Too Many Requests',
      };
    case 'not_found':
      return {
        status: 404,
        type: NOT_FOUND_TYPE,
        title: 'Not Found',
      };
  }
}

/**
 * Build a Problem Details body for a service-layer {@link AuthError}.
 *
 *   - Always surfaces the stable `code` so clients can branch on the
 *     machine-readable identifier without parsing `detail`.
 *   - For `rate_limited`, forwards `retryAfterSec` from
 *     `err.details` so the gateway can set the `Retry-After` HTTP
 *     header alongside the body.
 *   - Never copies an opaque `detail` string — the gateway keeps
 *     user-facing translation on the client side.
 */
function authErrorBody(code: AuthErrorCode, traceId: string): ProblemDetailsBody {
  const { status, type, title } = authCodeToStatus(code);
  return {
    type,
    title,
    status,
    code,
    traceId,
  };
}

/**
 * Generic 500 body. Deliberately omits `detail`, `code`, `errors` and
 * any field that could leak internals. The `traceId` is the only
 * per-request value the client receives, enabling a support ticket to
 * correlate with server-side logs without exposing the underlying
 * failure.
 */
function internalServerErrorBody(traceId: string): ProblemDetailsBody {
  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    traceId,
  };
}

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

/**
 * Log an error at the correct level per the task contract:
 *
 *   • 4xx — `warn`, with `error.name` and `error.code?`. No
 *           `error.message` in the log line because 4xx usually
 *           carry user-controlled content and we do not want that
 *           content surfacing in centralised log aggregation unless
 *           explicitly opted in.
 *   • 5xx — `error`, with `error.name`, `error.code?` AND
 *           `error.message`. The message is log-only; the response
 *           body never carries it. Operators need the message for
 *           triage and the log pipeline is trusted with it.
 */
function logProblem(err: unknown, status: number, ctx: ProblemContext): void {
  const name = err instanceof Error ? err.name : typeof err;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;

  if (status >= 500) {
    const message = err instanceof Error ? err.message : String(err);
    // Postgres / Drizzle errors have a `cause` chain that carries
    // the real failure (ECONNRESET, connection terminated, etc.).
    // `stack` is trimmed to ~500 chars so the log line stays
    // small while keeping enough context for on-call triage.
    const cause =
      err instanceof Error && err.cause !== undefined
        ? err.cause instanceof Error
          ? `${err.cause.name}: ${err.cause.message}`
          : typeof err.cause === 'string'
            ? err.cause
            : (JSON.stringify(err.cause) ?? '[unserializable]')
        : undefined;
    const stack =
      err instanceof Error && err.stack !== undefined ? err.stack.slice(0, 500) : undefined;
    ctx.logger.error('unhandled error', {
      traceId: ctx.traceId,
      ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
      ...(ctx.studioId !== undefined ? { studioId: ctx.studioId } : {}),
      status,
      errorName: name,
      errorCode: code,
      errorMessage: message,
      ...(cause !== undefined ? { errorCause: cause } : {}),
      ...(stack !== undefined ? { errorStack: stack } : {}),
    });
    return;
  }

  // 4xx: warn, no message.
  ctx.logger.warn('handled error', {
    traceId: ctx.traceId,
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(ctx.studioId !== undefined ? { studioId: ctx.studioId } : {}),
    status,
    errorName: name,
    errorCode: code,
  });
}

/* ------------------------------------------------------------------ */
/*  toProblemResponse                                                  */
/* ------------------------------------------------------------------ */

/**
 * Pure mapper from an arbitrary error into a Problem Details
 * response. Also emits a log line at the level appropriate for the
 * mapped status code (see {@link logProblem}).
 *
 * Priority order of the `instanceof` checks:
 *
 *   1. {@link ValidationError}            → 422 validation body.
 *   2. {@link MissingAuthClaimsError}     → 401 unauthenticated body.
 *   3. {@link TenantResourceNotFoundError} → 404, via
 *      {@link tenantErrorToProblem} (reuses the envelope built there).
 *   4. `AuthError` (duck-typed) from `@athlya/auth` → 401 / 404 /
 *      422 / 429 per its `code` field.
 *   5. Fallback — unknown `Error` or non-Error value — → 500 with a
 *      body that never leaks `err.message` / `err.stack`.
 */
export function toProblemResponse(err: unknown, ctx: ProblemContext): ProblemResponse {
  // Branch 1 — validation.
  if (err instanceof ValidationError) {
    const body = validationBody(err, ctx.traceId);
    logProblem(err, 422, ctx);
    return { status: 422, body };
  }

  // Branch 2 — missing auth claims.
  if (err instanceof MissingAuthClaimsError) {
    const body = missingAuthBody(err, ctx.traceId);
    logProblem(err, 401, ctx);
    return { status: 401, body };
  }

  // Branch 3 — tenant not found. Reuse the helper from `tenant.ts`
  // so a single owner controls the 404 shape. We merge in
  // `traceId` here because `tenantErrorToProblem` is intentionally
  // framework-free and does not know about the request scope.
  if (err instanceof TenantResourceNotFoundError) {
    const mapped = tenantErrorToProblem(err);
    if (mapped !== null) {
      const body: ProblemDetailsBody = {
        ...mapped.body,
        traceId: ctx.traceId,
      };
      logProblem(err, mapped.status, ctx);
      return { status: mapped.status, body };
    }
  }

  // Branch 4 — service-layer `AuthError`. Duck-typed to avoid a
  // compile-time dependency cycle on `@athlya/auth`. Maps the
  // stable `code` field onto the HTTP status documented in the
  // service module, so routes that `throw new AuthError(...)` end
  // up with the right problem+json body automatically.
  const authErr = asAuthError(err);
  if (authErr !== null) {
    const body = authErrorBody(authErr.code, ctx.traceId);
    logProblem(err, body.status, ctx);
    return { status: body.status, body };
  }

  // Branch 5 — chaos injection (CN.6.4). `ChaosInjectedError` has
  // `code === 'chaos_injected'`; duck-typed to avoid a dep on deps-cache.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'chaos_injected'
  ) {
    const body: ProblemDetailsBody = {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'chaos_injected',
      traceId: ctx.traceId,
    };
    logProblem(err, 503, ctx);
    return { status: 503, body };
  }

  // Branch 6 — fallback. Log with full message, return generic body.
  const body = internalServerErrorBody(ctx.traceId);
  logProblem(err, 500, ctx);
  return { status: 500, body };
}

/* ------------------------------------------------------------------ */
/*  registerErrorHandlers                                              */
/* ------------------------------------------------------------------ */

/**
 * Minimal Hono-app duck-type the helper needs.
 *
 * Declaring the shape locally (rather than importing `Hono<…>`)
 * keeps this module framework-free at the type level — tests can
 * pass a tiny `{ onError: vi.fn() }` fake without pulling in the
 * full Hono generic soup.
 */
export interface HonoLikeApp {
  onError(handler: (err: unknown, c: ErrorHandlerContext) => Response): unknown;
}

/**
 * Minimal context shape the `onError` handler reads. Matches the
 * surface Hono's `Context` exposes (`get`, `body`) without pulling
 * in Hono types.
 *
 * `body(data, status, headers)` is the same signature used by the
 * existing 401/404/500 handlers in `worker.ts`; the numeric-literal
 * status typing (`200 | 404 | 500 | …`) is widened to `number` here
 * because the mapper cannot know the status at compile time. Hono's
 * implementation accepts any integer status at runtime — the literal
 * types are a TypeScript convenience, not a runtime constraint.
 */
export interface ErrorHandlerContext {
  get(key: 'traceId'): string;
  get(key: 'logger'): ProblemLogger;
  /**
   * Sprint 12 / Slice 12.3 (Epic B7.1) — `authClaims` may be set
   * by `jwtAuth` upstream; the error handler reads it (best
   * effort) so 5xx log lines carry `userId` + `studioId` for
   * triage. Public routes leave it undefined.
   */
  get(key: 'authClaims'): unknown;
  body(data: string, status: number, headers: Record<string, string>): Response;
}

/**
 * Plug the pure {@link toProblemResponse} mapper into `app.onError`.
 *
 * The helper:
 *
 *   1. Reads `traceId` and `logger` from the request context — both
 *      guaranteed to be set by the tracing middleware installed in
 *      `worker.ts` before any route handler runs.
 *   2. Delegates to {@link toProblemResponse} for the `{ status,
 *      body }` pair.
 *   3. Emits the response with `content-type:
 *      application/problem+json` per RFC 9457.
 *   4. When {@link RegisterErrorHandlersOptions.onFiveHundred} is
 *      supplied AND the mapped status is 500, invokes the hook with
 *      the original error + the request context. Used by task 8.11
 *      to ship the thrown error to Sentry (Requirement 30.3). The
 *      hook's own failures are swallowed — it MUST NOT mask the
 *      primary response path.
 *
 * Does NOT touch `app.notFound` — the 404 handler stays inline in
 * `worker.ts` where it already emits a Problem Details envelope
 * without requiring the error-class dispatch above. Keeping the two
 * handlers separate keeps the 404 path cheap (no `instanceof` chain)
 * and avoids the risk of this helper accidentally overriding an
 * intentional 404 contract.
 */
export function registerErrorHandlers(
  app: HonoLikeApp,
  options: RegisterErrorHandlersOptions = {},
): void {
  app.onError((err, c) => {
    const traceId = c.get('traceId');
    const logger = c.get('logger');

    // Sprint 12 / Slice 12.3 (Epic B7.1) — best-effort extract
    // userId + studioId from `authClaims` for the unhandled
    // error log. Public routes leave the claims undefined; the
    // log line just omits the fields rather than carrying empty
    // strings.
    const claims = c.get('authClaims');
    let userId: string | undefined;
    let studioId: string | undefined;
    if (typeof claims === 'object' && claims !== null) {
      const claimsObj = claims as Record<string, unknown>;
      if (typeof claimsObj.userId === 'string') {
        userId = claimsObj.userId;
      }
      if (typeof claimsObj.studioId === 'string') {
        studioId = claimsObj.studioId;
      }
    }

    const { status, body } = toProblemResponse(err, {
      traceId,
      logger,
      ...(userId !== undefined ? { userId } : {}),
      ...(studioId !== undefined ? { studioId } : {}),
    });

    // Fire-and-forget Sentry capture for unhandled 500s. The
    // hook receives the ORIGINAL error (not the sanitised body)
    // so operators see the real stack trace in Sentry even
    // though the secret-leak guard has scrubbed it from the
    // wire. Errors inside the hook are swallowed — Req 30.3
    // requires the primary response to continue regardless.
    if (status >= 500 && options.onFiveHundred !== undefined) {
      try {
        // `c` at runtime is the full Hono `Context<HonoEnv>`
        // — we forward it as `unknown` so the hook can cast
        // to whatever shape it needs without this module
        // having to import Hono types.
        const result = options.onFiveHundred(err, c);
        if (result !== undefined && typeof result.then === 'function') {
          result.catch(() => undefined);
        }
      } catch {
        // Swallowed intentionally.
      }
    }

    return c.body(JSON.stringify(body), status, {
      'content-type': PROBLEM_JSON_CONTENT_TYPE,
    });
  });
}

/**
 * Options for {@link registerErrorHandlers}.
 *
 * `onFiveHundred` is invoked once per mapped 5xx response with the
 * original thrown error. Callers typically supply
 * `(err, c) => captureUnhandled(err, c)` from
 * `packages/api/src/sentry.ts`. The hook's return value may be a
 * Promise; the caller does NOT await it (capture is best-effort).
 */
export interface RegisterErrorHandlersOptions {
  readonly onFiveHundred?: (err: unknown, c: unknown) => void | Promise<void>;
}
