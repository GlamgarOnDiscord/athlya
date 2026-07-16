/**
 * Unit tests for the migration runner's CONCURRENTLY detection logic and
 * migration-file safety invariants (issue #490).
 *
 * The runner must skip the transaction wrapper for any migration body
 * that contains a CONCURRENTLY keyword, because PostgreSQL does not
 * allow CREATE/DROP INDEX CONCURRENTLY inside a transaction block.
 *
 * All CONCURRENTLY index migrations must include IF NOT EXISTS so they
 * are safe to replay when the runner crashes after the DDL succeeds but
 * before the migration record is written.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Duplicate the detection predicate from migrate.mjs as a pure function
// so we can test it without spinning up a database connection. Both copies
// must stay in sync — if the predicate changes in migrate.mjs, update this
// copy too and add a test case that exercises the change.
const requiresNoTx = (body: string): boolean => /\bCONCURRENTLY\b/i.test(body);

describe('migration runner: no-transaction detection', () => {
  it('detects CREATE INDEX CONCURRENTLY', () => {
    const body = `CREATE INDEX CONCURRENTLY "my_idx" ON "table" ("col");`;
    expect(requiresNoTx(body)).toBe(true);
  });

  it('detects DROP INDEX CONCURRENTLY', () => {
    const body = `DROP INDEX CONCURRENTLY IF EXISTS "my_idx";`;
    expect(requiresNoTx(body)).toBe(true);
  });

  it('detects lowercase concurrently', () => {
    const body = `CREATE INDEX concurrently "my_idx" ON "table" ("col");`;
    expect(requiresNoTx(body)).toBe(true);
  });

  it('detects CONCURRENTLY in a multi-statement migration', () => {
    const body = `
      ALTER TABLE reservations ADD COLUMN foo text;
      CREATE INDEX CONCURRENTLY "my_idx" ON "reservations" ("foo");
    `;
    expect(requiresNoTx(body)).toBe(true);
  });

  it('flags migration with CONCURRENTLY in executable SQL even when also present in a comment', () => {
    // Conservative: flag if keyword appears anywhere in the body.
    // The real constraint is that the DDL statement itself contains CONCURRENTLY;
    // a comment alone would not matter, but the regex doesn't parse SQL so it
    // matches on any occurrence — that is correct and safe.
    const body = `
      -- Cannot run inside a transaction; the migrator must execute this
      -- statement outside an open transaction block.
      CREATE INDEX CONCURRENTLY "my_idx" ON "t" ("c");
    `;
    expect(requiresNoTx(body)).toBe(true);
  });

  it('does not flag ordinary CREATE INDEX', () => {
    const body = `CREATE INDEX "my_idx" ON "table" ("col");`;
    expect(requiresNoTx(body)).toBe(false);
  });

  it('does not flag plain DDL migrations', () => {
    const body = `
      CREATE TABLE foo (id uuid PRIMARY KEY);
      ALTER TABLE foo ADD COLUMN name text NOT NULL;
    `;
    expect(requiresNoTx(body)).toBe(false);
  });

  it('does not false-positive on "concurrent" (no trailing boundary)', () => {
    // "concurrent" without the "ly" suffix — should not match \bCONCURRENTLY\b
    const body = `-- This migration handles concurrent writes via locking.`;
    expect(requiresNoTx(body)).toBe(false);
  });
});

// The CREATE INDEX CONCURRENTLY ... IF NOT EXISTS pattern guarantees that
// re-running a migration after a crash is safe. Every forward migration that
// contains CONCURRENTLY must also contain IF NOT EXISTS on the same DDL
// statement, so that a re-run after "index created, migration row missing"
// succeeds rather than throwing "relation already exists" (issue #490).
describe('migration files: CONCURRENTLY safety', () => {
  // Lines that execute a CONCURRENTLY DDL (not comments or DROP ... IF EXISTS).
  // We check that every such line also includes IF NOT EXISTS.
  const CREATE_CONCURRENTLY_RE = /^\s*CREATE\s+\S*\s*(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i;
  const IF_NOT_EXISTS_RE = /\bIF\s+NOT\s+EXISTS\b/i;

  const forwardMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  for (const file of forwardMigrations) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    if (!requiresNoTx(body)) continue;

    it(`${file}: every CREATE INDEX CONCURRENTLY line has IF NOT EXISTS`, () => {
      const violations = body
        .split('\n')
        .filter((line) => CREATE_CONCURRENTLY_RE.test(line) && !IF_NOT_EXISTS_RE.test(line));
      expect(violations).toEqual([]);
    });
  }
});
