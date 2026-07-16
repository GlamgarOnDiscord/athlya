/**
 * Diagnostic helper — promote a user to the `admin` role.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://localhost/athlya_dev'
 *   node packages/db/scripts/promote-admin.mjs <email>
 *
 * SAFETY (issue #509):
 *   - Refuses to run against a non-local DATABASE_URL unless
 *     ATHLYA_ALLOW_DANGEROUS_WRITE=1 is set.
 *   - Shows the current role before promoting and requires confirmation.
 *   - Non-interactive (CI/break-glass): set ATHLYA_CONFIRM=1 to skip the
 *     interactive confirmation prompt.
 */

import { createInterface } from 'node:readline';

import postgres from 'postgres';

import { guardConnectionString } from './_guard.mjs';

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

guardConnectionString(connectionString);

const sql = postgres(connectionString, { max: 1, prepare: false });

async function main() {
  const email = emailArg.trim().toLowerCase();

  // Read current state before mutating.
  const current = await sql`
    SELECT id, email, role, studio_id FROM users WHERE email = ${email} LIMIT 1
  `;
  if (current.length === 0) {
    console.log(JSON.stringify({ result: 'no user', email }));
    return;
  }
  const user = current[0];
  if (user.role === 'admin') {
    console.log(JSON.stringify({ result: 'already admin', id: user.id, email: user.email }));
    return;
  }

  console.log(
    `[promote-admin] user ${user.email} (${user.id}) studio=${user.studio_id} current role: ${user.role} → admin`,
  );

  // Require confirmation unless ATHLYA_CONFIRM=1 is set.
  if (process.env.ATHLYA_CONFIRM !== '1') {
    const confirmed = await new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Promote this user to admin? [y/N] ', (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
    if (!confirmed) {
      console.log('[promote-admin] Aborted.');
      return;
    }
  }

  const rows = await sql`
    UPDATE users
    SET role = 'admin'
    WHERE id = ${user.id}
    RETURNING id, email, role
  `;
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
