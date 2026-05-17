/**
 * Shared column builders and helpers reused across every Athlya table.
 *
 * Centralising these keeps column shapes uniform (every UUID is a v7, every
 * `createdAt` uses the same timestamp semantics, every soft-delete is
 * nullable `timestamptz`) and makes it trivial to change the default
 * strategy in one place — e.g. swap `gen_random_uuid()` for a dedicated
 * `uuid_generate_v7()` once the PostgreSQL extension is enabled in 2.2.
 *
 * Related requirements:
 *   - Requirement 5.1, 5.4 (soft-delete `deleted_at` pattern for RGPD).
 *   - Requirement 6.1 (UUID identifiers).
 *   - Requirement 22.1 (`createdAt` timestamps).
 */

import { sql, type SQL } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * SQL expression used as the default for every UUID primary key.
 *
 * Task 2.2 enables `pgcrypto` in `migrations/0000_init.sql` so
 * `gen_random_uuid()` is guaranteed to resolve on Neon PostgreSQL 17.
 * This produces UUID v4 values, which are correct but slightly less
 * index-locality-friendly than UUID v7.
 *
 * Once Neon ships `pg_uuidv7` as a managed extension, a follow-up
 * migration will run `CREATE EXTENSION pg_uuidv7` plus
 * `ALTER TABLE … ALTER COLUMN id SET DEFAULT uuid_generate_v7()` for
 * every table, and this constant will be flipped to
 * `sql\`uuid_generate_v7()\``. The Drizzle column type does not change,
 * so the swap is a SQL-only change. See the TODO at the top of
 * `0000_init.sql` and `migrations/README.md` for the tracking note.
 */
export const DEFAULT_UUID_SQL = sql`gen_random_uuid()`;

/**
 * Standard UUID primary-key column. Every top-level entity uses this shape.
 * Callers get UUID v7 values once 2.2 swaps the default expression.
 */
export function uuidPrimaryKey(name: string = 'id') {
  return uuid(name).primaryKey().default(DEFAULT_UUID_SQL);
}

/**
 * Standard `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` column.
 *
 * `withTimezone: true` is crucial on Neon: every downstream service
 * serialises timestamps via `toISOString()`, so we persist with explicit
 * UTC offsets rather than `timestamp without time zone`.
 */
export function createdAt(name: string = 'created_at') {
  return timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();
}

/**
 * Soft-delete column. Nullable by design — a `NULL` value means the row is
 * still live. Queries should filter with `deleted_at IS NULL` (via the
 * repository layer) by default.
 *
 * Requirement 5.1: `DELETE /auth/me` flips this flag; Requirement 5.4:
 * after 30 days a background job hard-deletes the row.
 */
export function deletedAt(name: string = 'deleted_at') {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

/**
 * Build a `"<column>" IS NULL` SQL predicate, for use in partial indexes.
 *
 * Drizzle's `.where()` on an index builder expects an `SQL` expression.
 * Writing the predicate by hand keeps the table definitions declarative
 * and sidesteps a minor gotcha where referencing a column object before
 * the table constant is fully defined can trip TypeScript's control-flow
 * analysis.
 */
export function sqlIsNull(column: string): SQL {
  return sql.raw(`"${column}" IS NULL`);
}
