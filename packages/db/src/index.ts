/**
 * Package barrel for `@athlya/db`.
 *
 * Downstream packages can either:
 *   - import the whole schema namespace via `@athlya/db`, or
 *   - reach for a specific sub-path such as `@athlya/db/schema`
 *     (preferred — lets bundlers tree-shake unused tables).
 *
 * Task 2.4 adds the tenant-aware Drizzle client (`createDb`,
 * `withTenant`) and the typed error classes used by the API gateway's
 * Problem Details middleware. Task 2.5 adds the `idempotency` and
 * `outbox` helpers, also re-exported here.
 */

export * as schema from './schema/index.js';
export * from './schema/index.js';

export {
  createDb,
  createDbFromClient,
  createDbHttp,
  createNeonHttpSql,
  pingDbHttp,
  pingDb,
  withTenant,
  InvalidClaimsError,
  type AthlyaDb,
  type AthlyaDbAny,
  type AthlyaDbHttp,
  type AthlyaTx,
  type AthlyaSchema,
  type CreateDbOptions,
  type TenantClaims,
  type TenantRole,
} from './client.js';
export {
  DbError,
  NotFoundError,
  notFoundIfEmpty,
  isPostgresUniqueViolation,
  isPostgresForeignKeyViolation,
  isPostgresCheckViolation,
  isPostgresSerializationFailure,
  isPostgresDeadlockDetected,
} from './errors.js';
export {
  lookup,
  store,
  DEFAULT_IDEMPOTENCY_TTL_SEC,
  InvalidIdempotencyInputError,
  type IdempotencyEntry,
} from './idempotency.js';
export {
  insertOutbox,
  claimBatch,
  markPublished,
  markFailed,
  InvalidOutboxInputError,
  type OutboxEvent,
  type ClaimedOutboxRow,
} from './outbox.js';
