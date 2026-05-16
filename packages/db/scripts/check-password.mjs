/**
 * Diagnostic helper — verify that a plaintext password matches the
 * bcrypt hash stored for a given user in the local Neon database.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL = 'postgresql://...'
 *   node scripts/check-password.mjs alice@athlya.test 'Alice-Password-Test-1!'
 *
 * Prints one of:
 *   - "no user" if the email does not match any row (active or soft-deleted)
 *   - "soft-deleted" if deleted_at is set (login is rejected regardless of password)
 *   - "no password" if password_hash is null (OAuth-only account)
 *   - "match" or "mismatch" for regular bcrypt verify results
 *
 * Read-only: performs no writes against the database.
 */

import postgres from 'postgres';
// Use createRequire to load bcryptjs from the @athlya/auth node_modules
// — @athlya/db does not depend on bcryptjs directly but we want to
// verify against the exact same hashing lib the service uses.
import { createRequire } from 'node:module';
const require = createRequire(
    new URL('../../auth/package.json', import.meta.url),
);
const bcrypt = require('bcryptjs');

const [, , emailArg, passwordArg] = process.argv;
if (!emailArg || !passwordArg) {
    console.error('usage: node scripts/check-password.mjs <email> <password>');
    process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false });

async function main() {
    const rows = await sql`
        SELECT id, email, password_hash, deleted_at
        FROM users
        WHERE email = ${emailArg.trim().toLowerCase()}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
        console.log(JSON.stringify({ result: 'no user', email: emailArg }));
        return;
    }
    if (row.deleted_at !== null) {
        console.log(
            JSON.stringify({
                result: 'soft-deleted',
                id: row.id,
                deletedAt: row.deleted_at,
            }),
        );
        return;
    }
    if (row.password_hash === null) {
        console.log(JSON.stringify({ result: 'no password', id: row.id }));
        return;
    }
    const ok = await bcrypt.compare(passwordArg, row.password_hash);
    console.log(
        JSON.stringify({
            result: ok ? 'match' : 'mismatch',
            id: row.id,
            hashPrefix: row.password_hash.slice(0, 7),
        }),
    );
}

try {
    await main();
} finally {
    await sql.end({ timeout: 2 });
}
