/**
 * Quick diagnostic: print the current state of a user row and
 * exercise the exact select Drizzle runs for `findUserByEmail`.
 *
 * Read-only: performs no writes against the database.
 *
 * SAFETY (issue #509): refuses to run against a non-local DATABASE_URL
 * unless ATHLYA_ALLOW_DANGEROUS_WRITE=1 is set.
 *
 * Usage:
 *   node packages/db/scripts/inspect-user.mjs <email>
 */

import postgres from 'postgres';

import { guardConnectionString } from './_guard.mjs';

const email = process.argv[2];
if (email === undefined) {
  console.error('usage: inspect-user.mjs <email>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

guardConnectionString(connectionString);

const sql = postgres(connectionString, { max: 1, prepare: false });
try {
  const rows = await sql`
        SELECT id, studio_id, email, display_name, role,
               password_hash IS NOT NULL AS has_password,
               created_at, deleted_at, consents::text AS consents_raw
        FROM users
        WHERE email = ${email}
    `;
  if (rows.length === 0) {
    console.log(`[inspect-user] no row for email=${email}`);
  } else {
    console.log('[inspect-user] rows:', rows);
  }

  // Also try the exact Drizzle-ish query shape from the adapter
  const probe = await sql`
        SELECT id, studio_id, email, display_name, avatar_url, role,
               consents, password_hash, created_at, deleted_at
        FROM users
        WHERE email = ${email}
        LIMIT 1
    `;
  console.log('[inspect-user] probe OK, returned', probe.length, 'row(s)');
} finally {
  await sql.end({ timeout: 2 });
}
