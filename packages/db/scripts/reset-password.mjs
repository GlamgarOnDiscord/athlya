/**
 * Diagnostic helper — replace a user's bcrypt password hash with a
 * fresh one computed from a known plaintext. Useful when a local dev
 * forgot the password they used at register time.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://...'
 *   node scripts/reset-password.mjs alice@athlya.test 'NewPassword-1!'
 *
 * Writes exactly one row. Refuses to run against a connection string
 * that does NOT resolve to a Neon host by default — edit the guard
 * if you need to run against a different provider.
 */

import postgres from 'postgres';
import { createRequire } from 'node:module';

const require = createRequire(
    new URL('../../auth/package.json', import.meta.url),
);
const bcrypt = require('bcryptjs');

const [, , emailArg, passwordArg] = process.argv;
if (!emailArg || !passwordArg) {
    console.error('usage: node scripts/reset-password.mjs <email> <password>');
    process.exit(2);
}
if (passwordArg.length > 72) {
    console.error('password must be <= 72 bytes (bcrypt limit)');
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
    const hash = await bcrypt.hash(passwordArg, 12);
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
