/**
 * Diagnostic helper — replace a user's bcrypt password hash with a
 * fresh one computed from a known plaintext. Useful when a local dev
 * forgot the password they used at register time.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://localhost/athlya_dev'
 *   node scripts/reset-password.mjs alice@athlya.test
 *   # prompted for password interactively
 *
 * Non-interactive (CI/break-glass):
 *   ATHLYA_SCRIPT_PASSWORD='...' node scripts/reset-password.mjs <email>
 *
 * SAFETY (issue #509):
 *   - Refuses to run against a non-local DATABASE_URL unless
 *     ATHLYA_ALLOW_DANGEROUS_WRITE=1 is set.
 *   - Password is read from stdin or ATHLYA_SCRIPT_PASSWORD, never
 *     from process.argv, to keep plaintext out of shell history and
 *     process listings.
 *   - Validates byte-length against bcrypt's 72-byte limit.
 */

import { createRequire } from 'node:module';

import postgres from 'postgres';

import { guardConnectionString, readPasswordFromStdin } from './_guard.mjs';

const require = createRequire(new URL('../../auth/package.json', import.meta.url));
const bcrypt = require('bcryptjs');

const [, , emailArg] = process.argv;
if (!emailArg) {
  console.error('usage: node scripts/reset-password.mjs <email>');
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

guardConnectionString(connectionString);

const passwordPlain = await readPasswordFromStdin('New password: ');

const encoder = new TextEncoder();
if (encoder.encode(passwordPlain).length > 72) {
  console.error('password must be <= 72 bytes when UTF-8 encoded (bcrypt limit)');
  process.exit(2);
}

const sql = postgres(connectionString, { max: 1, prepare: false });

async function main() {
  const email = emailArg.trim().toLowerCase();
  const hash = await bcrypt.hash(passwordPlain, 12);
  const rows = await sql`
    UPDATE users
    SET password_hash = ${hash}
    WHERE email = ${email}
    RETURNING id, email
  `;
  if (rows.length === 0) {
    console.log(JSON.stringify({ result: 'no user', email }));
    return;
  }
  console.log(
    JSON.stringify({
      result: 'updated',
      id: rows[0].id,
      email: rows[0].email,
    }),
  );
}

try {
  await main();
} finally {
  await sql.end({ timeout: 2 });
}
