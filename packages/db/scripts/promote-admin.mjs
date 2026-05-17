/**
 * Diagnostic helper — promote a user to the `admin` role.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://...'
 *   node packages/db/scripts/promote-admin.mjs <email>
 *
 * Read-after-write via RETURNING so the caller sees the new state.
 */

import postgres from 'postgres';

const [, , emailArg] = process.argv;
if (!emailArg) {
  console.error('usage: node scripts/promote-admin.mjs <email>');
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false });

async function main() {
  const email = emailArg.trim().toLowerCase();
  const rows = await sql`
        UPDATE users
        SET role = 'admin'
        WHERE email = ${email}
        RETURNING id, email, role
    `;
  if (rows.length === 0) {
    console.log(JSON.stringify({ result: 'no user', email }));
    return;
  }
  console.log(
    JSON.stringify({
      result: 'promoted',
      id: rows[0].id,
      email: rows[0].email,
      role: rows[0].role,
    }),
  );
}

try {
  await main();
} finally {
  await sql.end({ timeout: 2 });
}
