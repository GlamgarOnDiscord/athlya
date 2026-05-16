/**
 * Zod request-validation middleware (task 8.5).
 *
 * Satisfies Requirements 14.2 and 14.6 in concert with the Problem
 * Details mapper shipped by the sibling `problem-details.ts`:
 *
 *   • 14.2 — Every route SHALL validate its inbound payload (JSON
 *            body, query string, path params, headers) against the
 *            shared Zod schemas from `@athlya/shared/schemas`. A
 *            rejection is surfaced as HTTP 422 with a machine-
 *            readable Problem Details body.
 *   • 14.6 — The 422 response carries `type`, `title`, `status` and
 *            `traceId` per RFC 9457, plus an `errors: [{ path, code,
 *            message }]` array listing the individual Zod issues.
 *
 * Design — why throw instead of responding?
 * -----------------------------------------
 * The validator refuses to emit HTTP responses on its own. Instead,
 * on a schema failure it throws a typed {@link ValidationError}
 * carrying:
 *
 *   • `target`  — which source was being validated (`'json'`,
 *                 `'query'`, `'param'`, `'header'`);
 *   • `issues`  — the `ZodIssue[]` from the failed parse, verbatim.
 *
 * The global `onError` installed by `registerErrorHandlers(app)`
 * (sibling module) catches the error and renders the response.
 * Centralising the rendering keeps the envelope consistent across
 * every route — routes never have to think about Problem Details
 * shape or trace-id threading, they just `const body =
 * c.get('validated:json')` and keep going.
 *
 * Design — why framework-free?
 * ----------------------------
 * The validator intentionally does NOT import from `hono`. The
 * context it expects is duck-typed via {@link ValidatorContext}, the
 * same pattern the sibling middleware in this folder use. This gives
 * us:
 *
 *   1. Unit tests that build a tiny fake context with `vi.fn()`
 *      rather than spinning up Hono + a request round trip.
 *   2. Reuse from queue consumers and cron workers that replay a
 *      stored payload and want the same shape enforcement without
 *      pulling in Hono.
 *   3. Zero surprises if the gateway ever swaps Hono for a different
 *      edge framework — the validator's surface does not change.
 *
 * Design — where does the parsed result land?
 * -------------------------------------------
 * On success the validator writes the result onto the context under a
 * stable per-target key: `validated:json`, `validated:query`,
 * `validated:param`, `validated:header`. Route handlers read it back
 * with `c.get('validated:json')`. The pattern mirrors what
 * `@hono/zod-validator` itself does in the wild and keeps multiple
 * validations on the same route independently addressable (common
 * case: a route that validates path params AND a JSON body).
 */

import type { z } from 'zod';

/**
 * Alias for the public Zod schema interface. `z.ZodType<Out, In>`
 * carries enough information for `safeParse` to produce a
 * `ZodSafeParseResult<Out>`, which is all the factory needs.
 *
 * Re-aliased here (rather than importing `ZodType` by name) so
 * callers read a single import line and so renaming the zod symbol
 * in a future major is a one-line change.
 */
type ZodSchema<T> = z.ZodType<T>;

/**
 * Alias for the canonical Zod issue type. In zod v4 the public issue
 * union lives under `z.core.$ZodIssue`; the classic `ZodIssue` name
 * is a deprecated re-export. We alias `z.core.$ZodIssue` directly to
 * stay aligned with the upstream direction and avoid the deprecation
 * warning in strict typecheck runs.
 *
 * Re-exported so the Problem Details mapper in the sibling module
 * can type its `errors: ZodIssue[]` payload without re-aliasing.
 */
export type ZodIssue = z.core.$ZodIssue;

/* ------------------------------------------------------------------ */
/*  Targets                                                            */
/* ------------------------------------------------------------------ */

/**
 * Input sources the validator can target.
 *
 * Kept as a closed literal union so the context-key formatter below
 * can exhaustively narrow without runtime guards:
 *
 *   • `'json'`   — JSON request body parsed via `c.req.json()`.
 *   • `'query'`  — URL query string (`c.req.query()` returns a flat
 *                  `Record<string, string>`).
 *   • `'param'`  — path params (`c.req.param()`), typed as
 *                  `Record<string, string>` by Hono.
 *   • `'header'` — request headers (`c.req.header()` with no arg
 *                  returns all headers as a flat record).
 */
export type ValidationTarget = 'json' | 'query' | 'param' | 'header';

/**
 * Stable key under which a validated payload is stored on the
 * request context. Using a per-target key means a route that
 * validates both its JSON body AND its query string can read both
 * back independently.
 */
export function validatedContextKey(target: ValidationTarget): string {
  return `validated:${target}`;
}

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

/**
 * Thrown by the validator when a Zod parse fails.
 *
 * Carries the {@link ValidationTarget} that was being validated and
 * the verbatim `ZodIssue[]` from the failed parse, so the Problem
 * Details mapper in `problem-details.ts` can surface field-level
 * diagnostics without re-parsing.
 *
 * `code` mirrors the `code` convention used by
 * {@link MissingAuthClaimsError} and the `@athlya/db` error family:
 * a short machine-readable identifier the Problem Details mapper can
 * switch on without a type catalogue.
 *
 * The prototype chain is explicitly restored in the constructor.
 * TypeScript transpilers that down-level `extends Error` to ES5 can
 * otherwise flatten the chain, breaking `instanceof ValidationError`
 * in catch sites — the Problem Details mapper relies on that
 * `instanceof` check to route the error to the 422 branch.
 */
export class ValidationError extends Error {
  public override readonly name = 'ValidationError';

  /** Stable machine-readable identifier. */
  public readonly code = 'validation_error' as const;

  /** Which input source failed validation. */
  public readonly target: ValidationTarget;

  /** Verbatim Zod issues from the failed parse. */
  public readonly issues: readonly ZodIssue[];

  public constructor(target: ValidationTarget, issues: readonly ZodIssue[]) {
    super(`validation failed for ${target}`);
    this.target = target;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/*  Context shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal request-level reader the validator needs.
 *
 * Each property is typed as an async/sync function returning the
 * shape Hono's `HonoRequest` actually returns. `json()` is async
 * (reads the stream); the other three are sync dictionaries.
 *
 * Declared here (rather than imported from `hono`) so the validator
 * stays framework-free.
 */
export interface ValidatorRequest {
  /** Parse the JSON body. Called only when `target === 'json'`. */
  json(): Promise<unknown>;
  /** Flat query-string dictionary. Called when `target === 'query'`. */
  query(): Record<string, string | string[]>;
  /** Path-parameter dictionary. Called when `target === 'param'`. */
  param(): Record<string, string>;
  /** Full-header dictionary (no argument). Called when `target === 'header'`. */
  header(): Record<string, string>;
}

/**
 * Framework-free context shape accepted by the validator factory.
 *
 * Hono's `Context` satisfies this interface structurally — its
 * `req` exposes the four readers above, and its `set(key, value)`
 * accepts arbitrary string keys. Nothing about this shape is
 * Hono-specific.
 */
export interface ValidatorContext {
  readonly req: ValidatorRequest;
  set(key: string, value: unknown): void;
}

/** Hono-compatible `next` signature. */
export type ValidatorNext = () => Promise<void>;

/**
 * Middleware handler signature. Returning nothing (via `await next()`)
 * lets the request continue; throwing {@link ValidationError} hands
 * control to the global `onError` which renders the 422.
 */
export type ValidatorMiddleware<Out> = (
  c: ValidatorContext,
  next: ValidatorNext,
) => Promise<Out | void>;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read the raw input for a given target from the context.
 *
 * Every branch is ordered so the narrow-type `target` exhausts the
 * {@link ValidationTarget} union — TypeScript helps us keep the
 * switch total even if we add new targets later.
 */
async function readInput(target: ValidationTarget, req: ValidatorRequest): Promise<unknown> {
  switch (target) {
    case 'json':
      return req.json();
    case 'query':
      return req.query();
    case 'param':
      return req.param();
    case 'header':
      return req.header();
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a validation middleware for one `(target, schema)` pair.
 *
 * Behaviour per request:
 *
 *   1. Read the raw input for `target` from `c.req` via
 *      {@link readInput}. The `json()` branch is awaited; the others
 *      are synchronous dictionaries.
 *   2. Parse the raw input with `schema.safeParse(raw)`.
 *   3. On success, store the parsed value on the context under
 *      {@link validatedContextKey}`(target)` and call `next()`.
 *   4. On failure, throw a {@link ValidationError} carrying the
 *      verbatim `ZodIssue[]`. Control returns to the global
 *      `onError` installed by `registerErrorHandlers(app)`, which
 *      renders the 422 Problem Details envelope.
 *
 * The generic parameter `T` is the schema's *output* type — i.e.
 * what route handlers read back via `c.get('validated:json')`. It
 * propagates to the middleware's inferred signature so callers can
 * benefit from strong typing at the call site without a manual cast.
 */
export function zValidator<T>(
  target: ValidationTarget,
  schema: ZodSchema<T>,
): ValidatorMiddleware<void> {
  return async (c, next) => {
    const raw = await readInput(target, c.req);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // `parsed.error.issues` is the verbatim `ZodIssue[]` —
      // the Problem Details mapper flattens `.path` into a
      // dotted string and forwards `.code` / `.message`.
      throw new ValidationError(target, parsed.error.issues);
    }
    c.set(validatedContextKey(target), parsed.data);
    await next();
  };
}
