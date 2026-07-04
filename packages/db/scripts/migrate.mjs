/**
 * Apply every SQL migration under `packages/db/migrations/` to the
 * connection string in `DATABASE_URL` (env var). Intended for local
 * dev bootstrapping — production uses a stricter migration runner
 * with audit logging, dry runs and rollback gates.
 *
 * Behaviour
 * ---------
 *  • Reads every `NNNN_*.sql` file (NOT `*.down.sql`) under `migrations/`
 *    in lexicographic order.
 *  • Maintains a `_athlya_migrations(name text primary key, applied_at
 *    timestamptz default now())` table so re-running is idempotent.
 *  • Migrations whose body contains `CONCURRENTLY` (e.g. `CREATE INDEX
 *    CONCURRENTLY`) are executed outside a transaction — PostgreSQL forbids
 *    CONCURRENTLY inside a transaction block. These migrations are run with
 *    `sql.unsafe()` directly, then the tracking row is inserted in a
 *    separate immediate transaction.
 *  • All other migration files are wrapped in a single transaction so a
 *    partial failure leaves the schema untouched.
 *
 * Usage
 * -----
 *   $Env:DATABASE_URL="postgresql://..." ; node packages/db/scripts/migrate.mjs
 *
 *   OR via the package script:
 *     pnpm --filter @athlya/db run migrate
 *
 * Connection string (slice B2)
 * ----------------------------
 * Migrations run under a privileged role that can `CREATE ROLE`,
 * `GRANT`, `ALTER OWNER`, etc. The runtime role (`athlya_app`,
 * NOBYPASSRLS) cannot. To keep the two separate, this script reads
 * `MIGRATION_DATABASE_URL` (or `MIGRATION_DB_URL` as alias) when
 * present and falls back to `DATABASE_URL` for backward compat:
 *
 *   $Env:MIGRATION_DATABASE_URL="postgresql://neondb_owner:...@..."
 *   $Env:DATABASE_URL="postgresql://athlya_app:...@..."
 *   node packages/db/scripts/migrate.mjs
 *
 * In dev / CI both URLs may point to the same role — that is fine
 * and matches the pre-B2 single-URL setup.
 *
 * Requirements: Node 20+, `postgres` driver already in the package's
 * devDependencies (transitively via @athlya/db's dependencies).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `migrate: env var ${name} is required. Set DATABASE_URL or pass it via shell env.`,
    );
  }
  return v;
}

/**
 * Pick the migration connection string.
 *
 * Slice B2 splits the runtime role (`athlya_app`, RLS-enforced) from
 * the migration role (`neondb_owner`, BYPASSRLS, owns DDL). Migrations
 * MUST run under the privileged role because they may create roles,
 * grant privileges, alter ownership, etc. — operations `athlya_app`
 * cannot perform.
 *
 *   - `MIGRATION_DATABASE_URL` (preferred) → privileged role.
 *   - `DATABASE_URL`           (fallback)  → backward-compatible with
 *                                            pre-B2 setups that wired
 *                                            a single URL.
 *
 * The script also accepts `MIGRATION_DB_URL` as an alias for
 * `MIGRATION_DATABASE_URL` so it matches the wrangler bindings
 * naming convention used by the API package.
 */
function pickMigrationConnectionString() {
  const explicit = process.env.MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DB_URL;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }
  return requireEnv('DATABASE_URL');
}

async function ensureMigrationsTable(sql) {
  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS _athlya_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);
}

async function appliedSet(sql) {
  const rows = await sql`SELECT name FROM _athlya_migrations`;
  return new Set(rows.map((r) => r.name));
}

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

async function main() {
  const connectionString = pickMigrationConnectionString();
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => {}, // silence NOTICE chatter on idempotent runs
  });

  try {
    await ensureMigrationsTable(sql);
    const already = await appliedSet(sql);

    for (const { name, sql: body } of listMigrations()) {
      if (already.has(name)) {
        console.log(`[skip] ${name} (already applied)`);
        continue;
      }
      const requiresNoTx = /\bCONCURRENTLY\b/i.test(body);
      console.log(`[apply] ${name}${requiresNoTx ? ' (no-transaction)' : ''}...`);
      if (requiresNoTx) {
        // CONCURRENTLY DDL cannot run inside a transaction block. The
        // tracking INSERT runs in its own transaction immediately after.
        // A crash between the two leaves the migration applied but
        // untracked — the next run will retry and fail with "already
        // exists". Fix: add IF NOT EXISTS to the CONCURRENTLY statement.
        await sql.unsafe(body);
        await sql.begin((tx) => tx`INSERT INTO _athlya_migrations (name) VALUES (${name})`);
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`INSERT INTO _athlya_migrations (name) VALUES (${name})`;
        });
      }
      console.log(`[ok]    ${name}`);
    }
    console.log('[done] all migrations applied');
  } finally {
    await sql.end({ timeout: 2 });
  }
}

await main();
