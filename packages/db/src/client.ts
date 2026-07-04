/**
 * Tenant-aware Drizzle client factory.
 *
 * Every database transaction opened on behalf of an authenticated user
 * MUST carry three PostgreSQL session variables:
 *
 *   - `app.user_id`   — the requester's UUID (drives `reservations_read_own`,
 *                       `users_read_own`, …)
 *   - `app.studio_id` — the tenant boundary (drives `users_read_same_studio`,
 *                       `classes_read_same_studio`, …)
 *   - `app.role`      — RBAC label (`member` | `coach` | `admin`) consumed
 *                       by admin-only policies such as `audit_admin_only`.
 *
 * Once they are set, the RLS policies installed in migration 0001
 * (task 2.3) do the rest: cross-tenant reads return zero rows, and the
 * API gateway translates that into HTTP 404 via {@link NotFoundError}
 * so resource existence is not disclosed.
 *
 * Contract:
 *   1. Claims are validated against {@link validateClaims} BEFORE any
 *      SQL is issued. A malformed UUID or unknown role aborts the
 *      transaction immediately with {@link InvalidClaimsError}. Claim
 *      values therefore never reach the database as raw strings.
 *   2. Values are bound as parameters through drizzle's `sql` tag —
 *      never concatenated — so even if validation were bypassed, the
 *      driver would send them as a typed parameter rather than inline
 *      SQL text.
 *   3. `SET LOCAL` is scoped to the current transaction. Nothing leaks
 *      back to the connection pool when the transaction ends.
 *
 * Related requirements: 13.1 (session variables), 13.2–13.4 (RLS read
 * policies relying on those variables), 13.5 (cross-tenant → 404).
 */

import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { DbError } from './errors.js';
import * as schema from './schema/index.js';

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PostgresJsDatabase, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import type { Options, PostgresType, Sql } from 'postgres';

/** Union of the RBAC roles accepted by the `app.role` session variable. */
export type TenantRole = 'member' | 'coach' | 'admin';

/**
 * JWT-derived claims required to open a tenant-scoped transaction.
 * Fields are typed as plain strings here; shape validation happens in
 * {@link validateClaims} to keep the validator and the type in lock-step.
 */
export interface TenantClaims {
  readonly userId: string;
  readonly studioId: string;
  readonly role: TenantRole;
}

/**
 * Full schema exposed to the Drizzle type system. Bundling every table
 * under one namespace lets consumers write `db.select().from(users)`
 * without re-importing the table each time.
 */
export type AthlyaSchema = typeof schema;
export type AthlyaDb = PostgresJsDatabase<AthlyaSchema>;
export type AthlyaTx = PostgresJsTransaction<
  AthlyaSchema,
  ExtractTablesWithRelations<AthlyaSchema>
>;

/**
 * Drizzle handle backed by `@neondatabase/serverless`'s HTTP driver.
 *
 * Unlike {@link AthlyaDb} (postgres-js + TCP), the HTTP flavour is
 * stateless: each query is a `fetch` against Neon's SQL-over-HTTP
 * endpoint. That has two consequences for the Cloudflare Workers
 * runtime:
 *
 *   1. There is no socket to mark as "owned by request N", so the
 *      "Cannot perform I/O on behalf of a different request" error
 *      that plagues postgres-js cannot occur. The handle is safe to
 *      cache at module scope across requests inside one isolate.
 *   2. Transactions are limited to statement-array form
 *      (`db.transaction([stmt1, stmt2, ...])`); the interactive
 *      `db.transaction(async tx => …)` shape used by booking and
 *      cancellation (`SELECT FOR UPDATE` + conditional logic between
 *      statements) is NOT available on this flavour. Those flows
 *      keep using {@link AthlyaDb} via {@link createDb}.
 */
export type AthlyaDbHttp = NeonHttpDatabase<AthlyaSchema>;

/**
 * Union of both Drizzle flavours we ship. Every read-only adapter
 * (list / get / paginate) accepts this — the Drizzle query-builder
 * surface (`select`, `from`, `where`, `orderBy`, `limit`, `update`
 * for non-transactional writes, …) is identical across the two
 * subclasses of `PgDatabase`. Adapters that need `db.transaction()`
 * with TS-side branching between statements MUST narrow to
 * {@link AthlyaDb}.
 */
export type AthlyaDbAny = AthlyaDb | AthlyaDbHttp;

/**
 * Options accepted by {@link createDb}. Keeps the surface narrow on
 * purpose — deep driver tuning should go through a custom `postgres`
 * client supplied via {@link createDbFromClient}.
 */
export interface CreateDbOptions {
  /**
   * Pool size. Neon connections are serverless so the sensible
   * default is small; larger values are still honored when running
   * against a regional Postgres.
   */
  readonly maxConnections?: number;
  /**
   * Idle timeout in seconds. `0` disables the timer.
   */
  readonly idleTimeoutSec?: number;
  /**
   * Extra `postgres` driver options. Merged on top of the defaults.
   */
  readonly driver?: Options<Record<string, PostgresType>>;
}

/**
 * Thrown when {@link TenantClaims} fail schema validation. This is an
 * internal programmer error — the API gateway must have produced a
 * claim set from a verified JWT before reaching this layer — so it is
 * a distinct class and never translated to a 4xx response.
 */
export class InvalidClaimsError extends DbError {
  public constructor(field: keyof TenantClaims, reason: string) {
    super('invalid_tenant_claims', `invalid tenant claim "${field}": ${reason}`);
    this.name = 'InvalidClaimsError';
  }
}

/**
 * RFC 4122 UUID v1–8 with variant bits. Re-declared here rather than
 * imported from `@athlya/shared` to keep the db package's validation
 * dependency-free and independently auditable.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_ROLES: ReadonlySet<TenantRole> = new Set(['member', 'coach', 'admin']);

/**
 * Rejects malformed claims before they reach the database.
 *
 * Runs on every transaction open — the cost is negligible (three
 * regex checks) and the alternative (trusting upstream) would turn
 * any session-variable typo into a hard-to-diagnose RLS miss.
 */
function validateClaims(claims: TenantClaims): TenantClaims {
  if (typeof claims.userId !== 'string' || !UUID_REGEX.test(claims.userId)) {
    throw new InvalidClaimsError('userId', 'must be a UUID v1–8');
  }
  if (typeof claims.studioId !== 'string' || !UUID_REGEX.test(claims.studioId)) {
    throw new InvalidClaimsError('studioId', 'must be a UUID v1–8');
  }
  if (!VALID_ROLES.has(claims.role)) {
    throw new InvalidClaimsError('role', `must be one of 'member' | 'coach' | 'admin'`);
  }
  return claims;
}

/**
 * Creates a pooled Drizzle client against `connectionString`.
 *
 * A single process should keep ONE client alive for the lifetime of the
 * Worker / Node instance — `postgres` handles pooling internally. In a
 * Cloudflare Worker the pool degenerates to a per-isolate cache; that is
 * the expected behaviour.
 *
 * @throws `Error` — propagated from the `postgres` driver when the
 *   connection string is malformed.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): AthlyaDb {
  const driverOptions: Options<Record<string, PostgresType>> = {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSec ?? 30,
    prepare: false,
    ...options.driver,
  };
  const client = postgres(connectionString, driverOptions);
  return drizzle(client, { schema });
}

/**
 * Wraps an existing `postgres` client. Useful in tests, which can pass a
 * Testcontainers-backed client, and in integration pipelines that want
 * to reuse a client across multiple Drizzle instances.
 */
export function createDbFromClient(client: Sql): AthlyaDb {
  return drizzle(client, { schema });
}

/**
 * Build a stateless HTTP-driver Drizzle handle backed by
 * `@neondatabase/serverless`'s `neon()` SQL caller.
 *
 * Use this for every read query, plus simple writes that do NOT need
 * an interactive transaction (e.g. `INSERT ... RETURNING`,
 * `UPDATE ... WHERE` with optimistic-lock guards).
 *
 * Cloudflare Workers caching contract
 * -----------------------------------
 * The returned handle holds no I/O object — `neon()` returns a
 * tagged-template caller whose `fetch` invocation is created fresh
 * per query. Module-scope caching across requests is therefore safe
 * and recommended; the dependency-injection wiring layer
 * (`packages/api/src/adapters/*-deps.ts`) keys a per-isolate cache
 * on the connection string.
 *
 * Limitations
 * -----------
 * `db.transaction()` on this flavour only accepts a static array of
 * statements (`db.transaction([stmt1, stmt2])`). The interactive
 * callback form (`db.transaction(async tx => …)`) used by
 * `bookClass` / `cancelReservation` is unsupported here — those
 * flows stay on {@link createDb}.
 */
export function createDbHttp(connectionString: string): AthlyaDbHttp {
  const client = neon(connectionString);
  return drizzleHttp({ client, schema });
}

/**
 * Opens a transaction, sets the three `app.*` session variables from
 * {@link TenantClaims}, then hands a transactional Drizzle instance to
 * `fn`.
 *
 * Why `SET LOCAL` and not `SET SESSION`?
 *   `SET LOCAL` limits the scope to the enclosing transaction, so when
 *   the client returns to the pool every variable is cleared. A pooled
 *   connection can therefore not leak one user's `app.user_id` to the
 *   next request.
 *
 * Parameter binding: drizzle's `sql` tag escapes all interpolated
 * values; paired with the {@link validateClaims} guard, this gives us
 * defense in depth even if upstream claim extraction regresses.
 *
 * Driver constraint (Vague 18 — slice B1)
 * ---------------------------------------
 * The `db` parameter is typed as {@link AthlyaDb} (postgres-js)
 * **on purpose** — it CANNOT be called with {@link AthlyaDbHttp}.
 * The `@neondatabase/serverless` HTTP driver only supports the
 * statement-array form of `db.transaction([stmt1, stmt2, …])`; the
 * interactive callback form (`db.transaction(async tx => …)`) used
 * here for the three `SET LOCAL` statements followed by `fn(tx)` is
 * not available on that flavour. The TypeScript signature is the
 * first line of defense — every adapter that needs tenant-scoped
 * RLS must therefore route through a postgres-js Drizzle handle.
 *
 * For HTTP-driver tenant scoping (read paths, simple writes), a
 * future slice (B2) will introduce a `withTenantHttp` helper that
 * batches the three `SET LOCAL` statements with the read query in
 * a single statement-array transaction. Until then, every adapter
 * that uses the HTTP driver runs OUTSIDE `withTenant` and relies on
 * the application-layer `studioId` filter — see the design note in
 * `packages/api/src/adapters/reservations-deps.ts`.
 *
 * @throws {@link InvalidClaimsError} when claims are malformed.
 * @throws driver errors when the transaction or SET fails — callers
 *   are expected to map those to {@link DbError} at the boundary.
 */
export async function withTenant<T>(
  db: AthlyaDb,
  claims: TenantClaims,
  fn: (tx: AthlyaTx) => Promise<T>,
): Promise<T> {
  const safe = validateClaims(claims);
  return db.transaction(async (tx) => {
    // Every SET LOCAL uses parameter binding.
    // `set_config(name, value, is_local=true)` is the function
    // equivalent of `SET LOCAL name = value`; it accepts a bound
    // string parameter directly, which `SET LOCAL` syntactically
    // does not.
    await tx.execute(sql`select set_config('app.user_id', ${safe.userId}, true)`);
    await tx.execute(sql`select set_config('app.studio_id', ${safe.studioId}, true)`);
    await tx.execute(sql`select set_config('app.role', ${safe.role}, true)`);
    return fn(tx);
  });
}

/**
 * Run a single Drizzle query through the Neon HTTP driver with the
 * three tenant session variables set in the same network round-trip.
 *
 * ### Why this is necessary
 *
 * Unlike {@link withTenant} (postgres-js interactive transaction),
 * the Neon HTTP driver sends each Drizzle call as an independent HTTP
 * request to Neon's SQL-over-HTTP endpoint. A plain `db.select()` on
 * the HTTP driver therefore runs without any `app.*` session variables,
 * making the RLS policies on every tenant-scoped table evaluate their
 * `USING (studio_id = app_studio_id())` predicate against NULL — which,
 * when the connection role has BYPASSRLS (Neon's default provisioned
 * role), means the policy is skipped entirely and all rows are visible.
 *
 * `withTenantHttp` uses `db.batch([])` — Neon's HTTP batch API — which
 * sends all queries in a single HTTP request wrapped in a transaction.
 * The three `SET LOCAL` statements share that transaction with the
 * business query, so `app_studio_id()` / `app_user_id()` / `app_role()`
 * return the correct values when the query executes.
 *
 * ### Usage
 *
 * ```ts
 * const rows = await withTenantHttp(db, claims,
 *   db.select().from(users).where(eq(users.id, userId)),
 * );
 * ```
 *
 * Pass a **not-yet-awaited** Drizzle query builder as the third argument.
 * Do NOT `await` it before passing — the builder is lazy and `batch()`
 * will execute it alongside the SET LOCAL statements.
 *
 * @throws {@link InvalidClaimsError} when claims are malformed.
 */
export async function withTenantHttp<TResult>(
  db: AthlyaDbHttp,
  claims: TenantClaims,
  query: BatchItem<'pg'> & { _: { result: TResult } },
): Promise<TResult> {
  const safe = validateClaims(claims);
  // db.batch sends all queries in a single HTTP request wrapped in a
  // Neon transaction. SET LOCAL scoping applies within that transaction.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const [, , , result] = await db.batch([
    db.execute(sql`select set_config('app.user_id', ${safe.userId}, true)`),
    db.execute(sql`select set_config('app.studio_id', ${safe.studioId}, true)`),
    db.execute(sql`select set_config('app.role', ${safe.role}, true)`),
    query,
  ] as const);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return result as TResult;
}

/**
 * Probe the database with a `SELECT 1` over the HTTP driver.
 *
 * Sprint 11 / Slice 11.2 (Epic CN.9.4) — readiness probe helper.
 * Returns the round-trip latency in ms on success or throws the
 * driver error verbatim on failure. The caller is expected to wrap
 * the call in an `AbortSignal.timeout(...)`-bound promise to bound
 * the wait — `@neondatabase/serverless` honours `fetch`'s abort
 * signal but does not expose a per-call deadline option.
 *
 * Implementation note: the helper opens a single-shot HTTP client
 * (no connection pooling) because the readiness probe is invoked at
 * most a handful of times per second and re-using the cached
 * `AthlyaDbHttp` would tie the probe to the application's deps
 * lifecycle. The probe is intentionally orthogonal to the request
 * pipeline.
 */
export async function pingDbHttp(connectionString: string): Promise<number> {
  const started = Date.now();
  const sqlClient = neon(connectionString);
  await sqlClient`select 1`;
  return Date.now() - started;
}

/**
 * Probe Postgres over the wire protocol (postgres-js). Used by
 * `/health/ready` to validate the Hyperdrive write path separately
 * from the Neon HTTP read probe.
 */
export async function pingDb(connectionString: string): Promise<number> {
  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    prepare: false,
    connect_timeout: 2,
  });
  const started = Date.now();
  try {
    await client`select 1`;
    return Date.now() - started;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/**
 * Assert that the DB connection does not use a BYPASSRLS role.
 *
 * Queries `pg_roles` for the current user and throws if `rolbypassrls`
 * is true. Must be called once per Worker isolate cold start (issue #461).
 *
 * Only runs when `environment` is explicitly `'staging'` or `'production'`.
 * Any other value (including `undefined`, `'dev'`, `'test'`) skips the check
 * so local dev and CI pass without a real DB. The fail-safe direction is:
 * an unrecognised environment is treated as non-prod and skipped rather than
 * blocking, but a missing DB_URL binding simply causes `neon()` to throw,
 * which surfaces as a 500 and alerts ops.
 */
export async function assertRlsRole(connectionString: string, environment: string): Promise<void> {
  if (environment !== 'staging' && environment !== 'production') return;

  const sqlClient = neon(connectionString);
  const rows = await sqlClient`
    SELECT rolname::text AS name, rolbypassrls AS bypass
    FROM pg_roles
    WHERE rolname = current_user
  `;
  const row = (rows as Array<{ name: string; bypass: boolean }>)[0];
  if (row === undefined) {
    throw new Error('[boot] assertRlsRole: could not resolve current_user from pg_roles');
  }
  if (row.bypass) {
    throw new Error(
      `[boot] assertRlsRole: connected as "${row.name}" which has BYPASSRLS. ` +
        'Switch DB_URL to athlya_app (rolbypassrls=false) before serving traffic.',
    );
  }
  console.log(
    JSON.stringify({ event: 'rls-role-check', role: row.name, bypassrls: false, ok: true }),
  );
}

/**
 * Build a raw Neon HTTP SQL caller — bypass Drizzle entirely.
 *
 * Sprint 13 / Slice 13.2 — used by the cron handler in
 * `packages/api/src/adapters/cron-sql-executor.ts` to run arbitrary
 * positional-parameter SQL (e.g. `SELECT * FROM users WHERE …`).
 *
 * Returns the raw `neon()` caller, which is a tagged-template
 * function but ALSO accepts `(query: string, params: unknown[])`
 * positional form — the runtime accepts both, even though the
 * `.d.ts` only types the template-literal form. We cast through
 * `unknown` to expose the positional form to consumers that need
 * it (Drizzle owns the template-literal usage in the rest of this
 * module).
 */
export function createNeonHttpSql(
  connectionString: string,
): (query: string, params: readonly unknown[]) => Promise<unknown> {
  const client = neon(connectionString);
  // The runtime supports `client(query, params)` as a fallback
  // shape; the type definition only exposes the template-literal
  // form. Cast through `unknown` to surface the positional API.
  const positional = client as unknown as (
    query: string,
    params: readonly unknown[],
  ) => Promise<unknown>;
  return async (query, params) => positional(query, params);
}
