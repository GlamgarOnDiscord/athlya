/**
 * Tenant middleware helpers — framework-free.
 *
 * Satisfies Requirements 13.1 and 13.5 in concert with the Drizzle
 * client from task 2.4:
 *
 *   • 13.1 — Every authenticated database call MUST run inside a
 *            transaction whose three PostgreSQL session variables
 *            (`app.user_id`, `app.studio_id`, `app.role`) are set via
 *            `SET LOCAL`. {@link withTenantTx} is the canonical entry
 *            point: it pulls the JWT-derived {@link TenantClaims} out
 *            of the request context (populated by the auth middleware
 *            from task 8.2) and delegates to `withTenant(db, claims, fn)`
 *            exported by `@athlya/db/client`.
 *
 *   • 13.5 — A cross-tenant read, filtered to zero rows by RLS, MUST
 *            surface as `404 Not Found` without disclosing resource
 *            existence. {@link notFoundOnEmpty} is the translator
 *            route handlers call immediately after a single-row SELECT;
 *            {@link tenantErrorToProblem} converts the resulting
 *            {@link TenantResourceNotFoundError} into a Problem Details
 *            envelope that the global `onError` installed by task 8.5
 *            will render as the HTTP response.
 *
 * Why framework-free?
 * -------------------
 * The module imports nothing from Hono. The request context is typed
 * via the minimal {@link TenantMiddlewareContext} duck-type below so
 * the helpers compose equally well into:
 *
 *   • the Hono gateway in `worker.ts` (task 8.1 / 8.11),
 *   • queue consumer workers that replay an event on behalf of a
 *     specific tenant and need the same RLS guardrails,
 *   • unit tests that fabricate a context with `vi.fn()` — no Hono
 *     import required.
 *
 * The reference pattern is `security-headers.ts` in the same folder:
 * both modules expose a tiny context interface rather than reaching
 * for Hono's generics.
 *
 * What this module deliberately does NOT do
 * -----------------------------------------
 *   1. It does not emit HTTP responses. {@link withTenantTx} throws
 *      {@link MissingAuthClaimsError} when `authClaims` is absent on
 *      the context; the route handler or the global `onError` turns
 *      that into a 401. This keeps the helper pure: no `c.json`, no
 *      `Response` construction.
 *   2. It does not register anything on the global `app`. Task 8.5
 *      owns the global `onError` wiring and will call
 *      {@link tenantErrorToProblem} from there.
 *   3. It does not re-validate claim shape (UUIDs, role enum). The
 *      `withTenant` implementation in `@athlya/db` already runs
 *      `validateClaims` before issuing `SET LOCAL`; re-doing it here
 *      would double the cost and split ownership of the invariant.
 */

import { createDb, withTenant } from '@athlya/db';

import type { AthlyaDb, AthlyaTx, TenantClaims } from '@athlya/db';

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

/**
 * Thrown by {@link withTenantTx} when the request context does not
 * carry an `authClaims` entry.
 *
 * In the intended wiring, the auth middleware from task 8.2 populates
 * `c.set('authClaims', claims)` after verifying the `Authorization:
 * Bearer <jwt>` header. If this helper sees `undefined`, one of two
 * things has happened:
 *
 *   • the route is (incorrectly) mounted in front of the auth
 *     middleware — a programmer error that should be caught in
 *     integration tests, OR
 *   • the auth middleware decided the request is public and did not
 *     set the claims — in which case the route handler should not be
 *     reaching for a tenant-scoped DB call at all.
 *
 * Either way, this is an internal wiring mistake, not a user-facing
 * condition. The middleware surface intentionally does NOT emit a 401
 * from here: the global `onError` installed by task 8.5 decides how
 * to render this class (today: 401 Problem Details, tomorrow: maybe a
 * dedicated `type` URI with tenant-specific guidance).
 */
export class MissingAuthClaimsError extends Error {
    /**
     * Stable machine-readable identifier. Mirrors the `code` pattern
     * used across `@athlya/db` errors so the Problem Details mapper in
     * task 8.5 can reuse one lookup table for every error class in the
     * stack.
     */
    public readonly code = 'missing_auth_claims';

    public constructor(
        message = 'authClaims not present on context — ensure the auth middleware runs first',
    ) {
        super(message);
        this.name = 'MissingAuthClaimsError';
    }
}

/**
 * Thrown by {@link notFoundOnEmpty} when a tenant-scoped single-row
 * lookup returns zero rows post-RLS.
 *
 * The name is deliberately distinct from `@athlya/db`'s
 * {@link import('@athlya/db').NotFoundError} because:
 *
 *   • the DB-layer error carries the "repository said nothing" semantic
 *     independently of multi-tenancy (a legitimate not-found can happen
 *     within the caller's own tenant);
 *   • this API-layer error carries the stronger "cross-tenant reads are
 *     indistinguishable from missing rows" semantic from Req 13.5.
 *
 * Keeping them separate lets observability split the two populations
 * without forcing the whole stack to agree on a single class.
 */
export class TenantResourceNotFoundError extends Error {
    public readonly code = 'not_found';

    public constructor(message = 'resource not found') {
        super(message);
        this.name = 'TenantResourceNotFoundError';
    }
}

/* ------------------------------------------------------------------ */
/*  Context shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal bindings shape required by {@link withTenantTx}.
 *
 * The full `AthlyaBindings` interface (see `types.ts`) has many other
 * fields (REDIS_*, JWT_JWKS_URL, SENTRY_DSN …) but the tenant helper
 * only ever needs the Postgres connection string. Typing the context
 * against this narrow shape keeps the duck-type compatible with
 * anything else that exposes `env.DB_URL` — test harnesses, cron-only
 * workers that don't have a Redis binding, etc.
 */
export interface TenantMiddlewareEnv {
    readonly DB_URL: string;
}

/**
 * Minimal request-context shape accepted by the helpers.
 *
 * Hono's `Context` satisfies this interface by structural typing —
 * its `get(key)` returns `unknown | Variables[key]` depending on the
 * overload resolution, but both branches are assignable to `unknown`,
 * and its `env` field carries the worker bindings. No explicit cast
 * is required at the call site.
 *
 * Using `get(key: string): unknown` rather than a literal-key overload
 * keeps this module framework-free AND keeps it honest at runtime: the
 * helper treats `undefined` as the failure case even if the compile-
 * time shape of `AthlyaVariables` claims the field is always present.
 * That matters when the auth middleware is disabled for a specific
 * route (public endpoints) and the route accidentally reaches for a
 * tenant-scoped helper anyway.
 */
export interface TenantMiddlewareContext {
    /** Reads a variable set by upstream middleware. */
    get(key: string): unknown;
    /** Cloudflare Worker `env` bindings narrowed to what we need. */
    readonly env: TenantMiddlewareEnv;
}

/* ------------------------------------------------------------------ */
/*  Pooled client cache                                                */
/* ------------------------------------------------------------------ */

/**
 * Module-scoped pool of Drizzle clients keyed by connection string.
 *
 * Why a map and not a single global?
 *   A Worker isolate can serve requests for the dev, staging and
 *   production environments within its lifetime when testing a
 *   preview build, and different `env.DB_URL` values must not share
 *   a connection pool. Keying by URL keeps them isolated without
 *   forcing the Worker to instantiate a new client on every request.
 *
 * A `Map` is used rather than a plain object so:
 *   • connection strings containing `__proto__` or other reserved
 *     property names cannot poison the cache;
 *   • the cache can be cleared entirely from tests via
 *     {@link __resetTenantDbCache}.
 */
const dbPoolCache = new Map<string, AthlyaDb>();

/**
 * Resolve the cached Drizzle client for this env, creating one on
 * first use.
 *
 * `createDb` spins up a `postgres` pool; on Cloudflare Workers that
 * pool degenerates to a per-isolate cache, which is the intended
 * behaviour. The cache hit is O(1) and incurs no I/O — the whole
 * reason the helper exists is to avoid paying the `createDb` cost on
 * every request.
 */
function getCachedDb(env: TenantMiddlewareEnv): AthlyaDb {
    const url = env.DB_URL;
    const cached = dbPoolCache.get(url);
    if (cached !== undefined) {
        return cached;
    }
    const db = createDb(url);
    dbPoolCache.set(url, db);
    return db;
}

/**
 * Test-only seam that clears the module-level pool cache so
 * consecutive tests can swap in fresh mocks without residue.
 *
 * Intentionally prefixed with `__` to discourage application code from
 * calling it; production code never needs to drop the pool.
 */
export function __resetTenantDbCache(): void {
    dbPoolCache.clear();
}

/* ------------------------------------------------------------------ */
/*  withTenantTx                                                       */
/* ------------------------------------------------------------------ */

/**
 * Open a tenant-scoped transaction and run `fn` inside it.
 *
 * The flow is:
 *   1. Read `authClaims` from the context. If absent, throw
 *      {@link MissingAuthClaimsError} — the route handler or the
 *      global `onError` decides the HTTP shape.
 *   2. Resolve the cached Drizzle client for `c.env.DB_URL`.
 *   3. Delegate to `withTenant(db, claims, fn)` from
 *      `@athlya/db/client`. That helper validates the claims, opens a
 *      transaction, issues the three `SET LOCAL` statements, and
 *      invokes `fn` with the transactional Drizzle instance.
 *
 * The return value of `fn` is propagated unchanged. Any error thrown
 * inside `fn` rolls the transaction back (drizzle's `db.transaction`
 * semantics) and bubbles up to the caller — the helper does not
 * swallow errors.
 *
 * @typeParam T — the value produced by the transactional callback.
 * @throws {@link MissingAuthClaimsError} when `c.get('authClaims')` is
 *   `undefined`.
 * @throws Any error propagated from `withTenant` (invalid claims,
 *   driver failure, business error thrown by `fn`).
 */
export async function withTenantTx<T>(
    c: TenantMiddlewareContext,
    fn: (tx: AthlyaTx) => Promise<T>,
): Promise<T> {
    const rawClaims = c.get('authClaims');
    if (rawClaims === undefined || rawClaims === null) {
        throw new MissingAuthClaimsError();
    }

    const db = getCachedDb(c.env);

    // The cast mirrors the contract between this module and task 8.2:
    // the auth middleware is the sole writer of `authClaims` and only
    // ever stores a validated `TenantClaims`. `withTenant` revalidates
    // the shape anyway (defense in depth), so we do not re-check here.
    return withTenant(db, rawClaims as TenantClaims, fn);
}

/* ------------------------------------------------------------------ */
/*  notFoundOnEmpty                                                    */
/* ------------------------------------------------------------------ */

/**
 * Translate a single-row tenant-scoped query result into either the
 * row itself or a {@link TenantResourceNotFoundError}.
 *
 * Typical usage inside a route handler:
 *
 * ```ts
 * const rows = await withTenantTx(c, (tx) =>
 *     tx.select().from(reservations).where(eq(reservations.id, id)).limit(1),
 * );
 * const reservation = notFoundOnEmpty(rows, `reservation ${id}`);
 * ```
 *
 * Because RLS filters out rows belonging to another tenant BEFORE the
 * query returns, an empty result is indistinguishable between "the row
 * does not exist" and "the row exists but belongs to another studio".
 * This function makes the 404 translation explicit and consistent
 * across every route.
 *
 * @throws {@link TenantResourceNotFoundError} when `rows.length === 0`.
 */
export function notFoundOnEmpty<T>(rows: readonly T[], detail?: string): T {
    if (rows.length === 0) {
        throw new TenantResourceNotFoundError(detail ?? 'resource not found');
    }
    // Safe: length > 0 implies rows[0] is defined. The `as T` cast is
    // required under `noUncheckedIndexedAccess` — see `tsconfig/base.json`.
    return rows[0] as T;
}

/* ------------------------------------------------------------------ */
/*  tenantErrorToProblem                                               */
/* ------------------------------------------------------------------ */

/**
 * Minimal Problem Details body (RFC 7807) emitted by this middleware.
 *
 * The shape is a strict subset of `@athlya/shared`'s `ProblemDetails`
 * type — type-compatible without an import so this module stays free
 * of Zod runtime weight. Task 8.5 is the owner of the end-to-end
 * envelope (it fills in `traceId` from the per-request logger) and
 * will merge these fields into the final response.
 */
export interface TenantProblemBody {
    /** RFC 7807 `type` URI. Defaults to `about:blank` per spec. */
    readonly type: string;
    /** Short human-readable title — the HTTP status phrase. */
    readonly title: string;
    /** Numeric HTTP status code, duplicated in the body per RFC 7807. */
    readonly status: number;
    /** Optional human-readable detail. */
    readonly detail?: string;
    /** Athlya-specific machine-readable identifier. */
    readonly code?: string;
}

/**
 * Response shape produced by {@link tenantErrorToProblem}.
 *
 * `status` is broken out at the top level (rather than read from
 * `body.status`) so the onError integration in task 8.5 can call
 * `c.json(body, status)` without de-structuring twice.
 */
export interface TenantProblemResponse {
    readonly status: number;
    readonly body: TenantProblemBody;
}

/**
 * Pure error-to-Problem-Details translator.
 *
 * Returns:
 *   • a 404 Problem Details response when `err` is a
 *     {@link TenantResourceNotFoundError},
 *   • `null` otherwise — the global `onError` in task 8.5 MUST then
 *     delegate to the next handler in its chain (schema validation,
 *     auth, generic 500 fallback, …).
 *
 * Intentionally does NOT handle {@link MissingAuthClaimsError}: that
 * class is a programmer-facing error about missing upstream wiring,
 * not a user-facing 4xx. Task 8.2 or the global fallback is the right
 * owner for mapping it to 401.
 *
 * Pure function — safe to unit-test in isolation, safe to call with
 * any `unknown` without side effects.
 */
export function tenantErrorToProblem(err: unknown): TenantProblemResponse | null {
    if (err instanceof TenantResourceNotFoundError) {
        return {
            status: 404,
            body: {
                type: 'about:blank',
                title: 'Not Found',
                status: 404,
                detail: err.message,
                code: err.code,
            },
        };
    }
    return null;
}
