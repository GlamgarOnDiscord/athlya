/**
 * Mark a migration as applied WITHOUT running it. Used when a
 * migration requires privileges the target database does not grant
 * (e.g. Neon's `neondb_owner` cannot `CREATE ROLE ... BYPASSRLS`),
 * and the schema changes driven by that migration are applied out of
 * band or intentionally skipped for local dev.
 *
 * Usage:
 *   node packages/db/scripts/mark-applied.mjs <migration-file-name>
 *
 * The name must match the exact basename of a file under
 * `migrations/`, including the `.sql` suffix.
 */

import postgres from 'postgres';

const name = process.argv[2];
if (name === undefined || name === '') {
  console.error('usage: mark-applied.mjs <migration-file-name>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false });
try {
  await sql`
        INSERT INTO _athlya_migrations (name)
        VALUES (${name})
        ON CONFLICT (name) DO NOTHING
    `;
  console.log(`[marked] ${name}`);
} finally {
  await sql.end({ timeout: 2 });
}
