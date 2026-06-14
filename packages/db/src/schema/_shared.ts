/**
 * Shared column builders and helpers reused across every Athlya table.
 *
 * Centralising these keeps column shapes uniform (every UUID primary key
 * is a v7, every `createdAt` uses the same timestamp semantics, every
 * soft-delete is nullable `timestamptz`) and makes it trivial to change
 * the default strategy in one place.
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
 * `gen_uuid_v7()` is a pure-SQL function added in migration 0016 (issue
 * #232). It embeds a 48-bit Unix-ms timestamp in the leading bytes of the
 * UUID (RFC 9562 §5.7), which guarantees monotonically increasing B-tree
 * insertions — eliminating the index fragmentation caused by the previous
 * random UUID v4 default.
 *
 * No PostgreSQL extension is required; the function works on Neon
 * PostgreSQL 17 out of the box.
 */
export const DEFAULT_UUID_SQL = sql`gen_uuid_v7()`;

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
