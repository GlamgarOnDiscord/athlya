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
 *
 * SAFETY (issue #509):
 *   - Refuses to run against a non-local DATABASE_URL unless
 *     ATHLYA_ALLOW_DANGEROUS_WRITE=1 is set.
 *   - Verifies the migration file exists before inserting the record.
 *   - Non-interactive confirmation: set ATHLYA_CONFIRM=1 to skip prompt.
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { guardConnectionString } from './_guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const name = process.argv[2];
if (name === undefined || name === '') {
  console.error('usage: mark-applied.mjs <migration-file-name>');
  process.exit(1);
}

// Verify the migration file exists before recording it.
const migrationPath = join(MIGRATIONS_DIR, name);
if (!existsSync(migrationPath)) {
  console.error(`[mark-applied] Migration file not found: ${migrationPath}`);
  console.error('Only files that exist in migrations/ can be marked applied.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

guardConnectionString(connectionString);

// Require explicit confirmation unless ATHLYA_CONFIRM=1 is set.
if (process.env.ATHLYA_CONFIRM !== '1') {
  const confirmed = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Mark "${name}" as applied without running it? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
  if (!confirmed) {
    console.log('[mark-applied] Aborted.');
    process.exit(0);
  }
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
