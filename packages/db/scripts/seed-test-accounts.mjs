/**
 * Create or update the test accounts of the fictional "Studio Rive
 * Gauche": one account per role (admin, manager, accueil, coach,
 * member), all signing in with TEST_ACCOUNTS_PASSWORD (issue #758).
 *
 * Idempotent: the studio is matched by slug and each account by email.
 * A second run changes nothing, unless the password or a role differs,
 * in which case the account is updated and its `credentials_version`
 * bumped so tokens minted before the change stop mutating. An email
 * already used by an account of another studio stops the run.
 *
 * Passwords are hashed with bcrypt at the cost the auth Worker uses
 * (`BCRYPT_COST` of `@athlya/auth`, 12).
 *
 * Usage (from the repository root, as the migration owner role, which
 * bypasses RLS like the other seed scripts):
 *   DATABASE_URL=postgresql://... TEST_ACCOUNTS_PASSWORD=... \
 *     node packages/db/scripts/seed-test-accounts.mjs
 * Refuses to run with APP_ENV=production unless `--allow-production` is
 * passed, and refuses a remote host unless ATHLYA_ALLOW_DANGEROUS_WRITE=1
 * (`_guard.mjs`). Runbook: docs/runbooks/test-accounts.md.
 */

import { createRequire } from 'node:module';

import postgres from 'postgres';

import { guardConnectionString } from './_guard.mjs';
import {
  TEST_ACCOUNTS,
  TEST_STUDIO,
  parseArgs,
  readSeedEnvironment,
  seedConsents,
} from './seed-test-accounts-lib.mjs';

const require = createRequire(new URL('../../auth/package.json', import.meta.url));
const bcrypt = require('bcryptjs');

/** `BCRYPT_COST` of `packages/auth/src/password.ts`. */
const BCRYPT_COST = 12;

let config;
try {
  config = readSeedEnvironment(process.env, parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`[seed-test-accounts] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

guardConnectionString(config.databaseUrl);

const sql = postgres(config.databaseUrl, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    const [studio] = await tx`
      INSERT INTO studios (slug, name)
      VALUES (${TEST_STUDIO.slug}, ${TEST_STUDIO.name})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;

    for (const account of TEST_ACCOUNTS) {
      const [existing] = await tx`
        SELECT id, studio_id, role::text AS role, password_hash
          FROM users
         WHERE email = ${account.email} AND deleted_at IS NULL
      `;
      if (existing === undefined) {
        const passwordHash = await bcrypt.hash(config.password, BCRYPT_COST);
        await tx`
          INSERT INTO users (studio_id, email, display_name, role, consents, password_hash)
          VALUES (${studio.id}, ${account.email}, ${account.displayName},
                  ${account.role}::user_role, ${tx.json(seedConsents(new Date()))},
                  ${passwordHash})
        `;
        console.log(`[seed-test-accounts] created ${account.role}: ${account.email}`);
        continue;
      }
      if (existing.studio_id !== studio.id) {
        throw new Error(`${account.email} belongs to another studio; not touching it`);
      }
      const samePassword =
        existing.password_hash !== null &&
        (await bcrypt.compare(config.password, existing.password_hash));
      if (samePassword && existing.role === account.role) {
        await tx`UPDATE users SET display_name = ${account.displayName} WHERE id = ${existing.id}`;
        console.log(`[seed-test-accounts] up to date ${account.role}: ${account.email}`);
        continue;
      }
      const passwordHash = samePassword
        ? existing.password_hash
        : await bcrypt.hash(config.password, BCRYPT_COST);
      await tx`
        UPDATE users
           SET display_name = ${account.displayName},
               role = ${account.role}::user_role,
               password_hash = ${passwordHash},
               credentials_version = credentials_version + 1
         WHERE id = ${existing.id}
      `;
      console.log(`[seed-test-accounts] updated ${account.role}: ${account.email}`);
    }
  });
  console.log(`[seed-test-accounts] ${TEST_STUDIO.name} (${TEST_STUDIO.slug}) is ready`);
} catch (err) {
  console.error(`[seed-test-accounts] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
