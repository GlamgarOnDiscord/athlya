#!/usr/bin/env node
/**
 * Post-cutover smoke: verify DATABASE_URL uses a non-BYPASSRLS role and
 * RLS filters cross-tenant reads.
 *
 * Usage (after switching DB_URL to athlya_app):
 *   DATABASE_URL="postgresql://athlya_app:..." node scripts/smoke-rls-cutover.mjs
 *
 * Optional:
 *   SMOKE_STUDIO_ID=<uuid>  — real studio to probe admin read (must exist)
 *   SMOKE_ADMIN_ID=<uuid>   — admin user in that studio
 *
 * Exit 0 = RLS cutover looks healthy. Exit 1 = still on owner / RLS inactive.
 * See docs/runbooks/db-role-switch.md (issue #117).
 */

import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('[smoke-rls] DATABASE_URL is required');
  process.exit(1);
}

const FAKE_USER = '00000000-0000-4000-8000-000000000001';
const FAKE_STUDIO = '00000000-0000-4000-8000-000000000002';

const sql = postgres(connectionString, { max: 1, prepare: false });

function fail(message) {
  console.error(`[smoke-rls] FAIL: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[smoke-rls] OK: ${message}`);
}

try {
  const [roleRow] = await sql`
    SELECT rolname::text AS name, rolbypassrls AS bypass_rls, rolsuper AS superuser
    FROM pg_roles
    WHERE rolname = current_user
  `;
  if (roleRow === undefined) {
    fail('could not resolve current_user');
  }

  console.log(
    `[smoke-rls] connected as ${roleRow.name} (bypass_rls=${String(roleRow.bypass_rls)}, superuser=${String(roleRow.superuser)})`,
  );

  if (roleRow.bypass_rls !== false || roleRow.superuser !== false) {
    fail(
      'current role has BYPASSRLS or SUPERUSER — DB_URL likely still neondb_owner. Switch to athlya_app first.',
    );
  }
  ok('runtime role does not bypass RLS');

  const migRows = await sql`
    SELECT 1 FROM _athlya_migrations WHERE name = '0011_audit_log_app_insert.sql'
  `;
  if (migRows.length === 0) {
    fail('migration 0011_audit_log_app_insert.sql not applied — run migrate before cutover');
  }
  ok('0011 audit insert migration applied');

  const [policyRow] = await sql`
    SELECT policyname::text AS name
    FROM pg_policies
    WHERE tablename = 'audit_log' AND policyname = 'audit_app_insert'
  `;
  if (policyRow === undefined) {
    fail('policy audit_app_insert missing on audit_log');
  }
  ok('audit_app_insert policy present');

  const [unscoped] = await sql`SELECT count(*)::int AS n FROM users`;
  if (unscoped.n > 0) {
    fail(
      `unscoped SELECT on users returned ${unscoped.n} row(s) — RLS not enforcing (owner role?)`,
    );
  }
  ok('unscoped users SELECT returns 0 rows');

  await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.user_id', '${FAKE_USER}', true)`);
    await tx.unsafe(`SELECT set_config('app.studio_id', '${FAKE_STUDIO}', true)`);
    await tx.unsafe(`SELECT set_config('app.role', 'member', true)`);

    const [scoped] = await tx`SELECT count(*)::int AS n FROM users`;
    if (scoped.n !== 0) {
      fail(`scoped member SELECT on users returned ${scoped.n}, expected 0`);
    }

    await tx.unsafe(`
      INSERT INTO audit_log (actor_id, action, metadata)
      VALUES (NULL, 'smoke.rls.cutover', '{}'::jsonb)
    `);
    throw new Error('ROLLBACK_SMOKE');
  }).catch((err) => {
    if (!(err instanceof Error) || err.message !== 'ROLLBACK_SMOKE') {
      throw err;
    }
  });
  ok('audit_log INSERT succeeds under tenant GUC (rolled back)');

  const studioId = process.env.SMOKE_STUDIO_ID;
  const adminId = process.env.SMOKE_ADMIN_ID;
  if (studioId !== undefined && adminId !== undefined) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.user_id', '${adminId}', true)`);
      await tx.unsafe(`SELECT set_config('app.studio_id', '${studioId}', true)`);
      await tx.unsafe(`SELECT set_config('app.role', 'admin', true)`);

      const [adminCount] = await tx`SELECT count(*)::int AS n FROM users`;
      if (adminCount.n === 0) {
        fail('admin scoped SELECT returned 0 — check SMOKE_STUDIO_ID / SMOKE_ADMIN_ID');
      }
      ok(`admin scoped SELECT returned ${adminCount.n} user(s) in studio`);
    });
  } else {
    console.log('[smoke-rls] skip studio probe (set SMOKE_STUDIO_ID + SMOKE_ADMIN_ID for full check)');
  }

  console.log('[smoke-rls] all checks passed');
} catch (err) {
  if (err instanceof Error && err.message.startsWith('[smoke-rls]')) {
    throw err;
  }
  console.error('[smoke-rls] unexpected error:', err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 2 });
}
