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
 *
 * A no-transaction migration must also be sent one statement per query:
 * a multi-statement simple query is an implicit transaction block, so
 * CONCURRENTLY fails there too (issue #664).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  planMigration,
  requiresNoTransaction as requiresNoTx,
  splitSqlStatements,
} from '../scripts/migrate-lib.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const forwardMigrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();

const readMigration = (file: string): string => readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');

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

  for (const file of forwardMigrations) {
    const body = readMigration(file);
    if (!requiresNoTx(body)) continue;

    it(`${file}: every CREATE INDEX CONCURRENTLY line has IF NOT EXISTS`, () => {
      const violations = body
        .split('\n')
        .filter((line) => CREATE_CONCURRENTLY_RE.test(line) && !IF_NOT_EXISTS_RE.test(line));
      expect(violations).toEqual([]);
    });
  }
});

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and trims', () => {
    expect(splitSqlStatements('SELECT 1;\n  SELECT 2 ;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a trailing statement without a semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops line comments, block comments and drizzle breakpoints', () => {
    const body = `
      -- header; with a semicolon
      /* block; /* nested; */ still comment */
      DROP INDEX IF EXISTS "a";--> statement-breakpoint
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "b" ON "t" ("c"); -- trailing; note
    `;
    const statements = splitSqlStatements(body);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('DROP INDEX IF EXISTS "a"');
    expect(statements[1]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "b" ON "t" \("c"\)$/);
  });

  it('skips comment-only scripts', () => {
    expect(splitSqlStatements('-- nothing to run;\n/* ; */\n;;')).toEqual([]);
  });

  it('ignores semicolons inside string literals and quoted identifiers', () => {
    const body = `INSERT INTO "we;ird" VALUES ('a;b', 'it''s; fine', E'x\\';y'); SELECT 1;`;
    expect(splitSqlStatements(body)).toEqual([
      `INSERT INTO "we;ird" VALUES ('a;b', 'it''s; fine', E'x\\';y')`,
      'SELECT 1',
    ]);
  });

  it('keeps comment markers inside string literals', () => {
    expect(splitSqlStatements(`SELECT '-- not a comment; really'`)).toEqual([
      `SELECT '-- not a comment; really'`,
    ]);
  });

  it('ignores semicolons inside dollar-quoted bodies', () => {
    const body = `
      DO $body$ BEGIN PERFORM 1; PERFORM $$x;y$$; END $body$;
      CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;
      SELECT $1::int;
    `;
    const statements = splitSqlStatements(body);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe('DO $body$ BEGIN PERFORM 1; PERFORM $$x;y$$; END $body$');
    expect(statements[1]).toBe('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$');
    expect(statements[2]).toBe('SELECT $1::int');
  });
});

describe('planMigration', () => {
  it('runs ordinary migrations as one transactional query', () => {
    const body = 'CREATE TABLE a (id int);\nCREATE INDEX ON a (id);';
    expect(planMigration(body)).toEqual({ transactional: true, queries: [body] });
  });

  it('runs CONCURRENTLY migrations one statement per query, outside a transaction', () => {
    const body = `DROP INDEX IF EXISTS "old";\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "new" ON "t" ("c");`;
    expect(planMigration(body)).toEqual({
      transactional: false,
      queries: [
        'DROP INDEX IF EXISTS "old"',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "new" ON "t" ("c")',
      ],
    });
  });

  it('splits 0028 so CREATE UNIQUE INDEX CONCURRENTLY runs on its own', () => {
    const plan = planMigration(readMigration('0028_reservations_class_user_partial_unique.sql'));
    expect(plan.transactional).toBe(false);
    expect(plan.queries).toHaveLength(2);
    expect(plan.queries[0]).toMatch(/^DROP INDEX IF EXISTS "reservations_class_user_unique"$/);
    expect(plan.queries[1]).toMatch(/^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/);
  });
});

// PostgreSQL rejects CONCURRENTLY in a multi-statement simple query (it is an
// implicit transaction block), so every no-transaction query must hold exactly
// one statement. Each statement must also be replay-safe, because a crash
// part-way through re-runs the whole file on the next deploy (issue #664).
describe('migration files: no-transaction plan', () => {
  const CREATE_OR_DROP_RE = /^(?:CREATE|DROP)\b/i;
  const IF_EXISTS_RE = /\bIF\s+(?:NOT\s+)?EXISTS\b/i;

  for (const file of forwardMigrations) {
    const plan = planMigration(readMigration(file));
    if (plan.transactional) continue;

    it(`${file}: sends one statement per query`, () => {
      expect(plan.queries.length).toBeGreaterThan(0);
      for (const query of plan.queries) {
        expect(splitSqlStatements(query)).toEqual([query]);
      }
    });

    it(`${file}: every CREATE/DROP is guarded by IF [NOT] EXISTS`, () => {
      const unguarded = plan.queries.filter(
        (query) => CREATE_OR_DROP_RE.test(query) && !IF_EXISTS_RE.test(query),
      );
      expect(unguarded).toEqual([]);
    });
  }
});
