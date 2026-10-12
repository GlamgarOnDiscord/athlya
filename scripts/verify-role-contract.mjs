#!/usr/bin/env node
/**
 * Runtime role contract (issue #117) — replays every claim-less and
 * tenant workload against the REAL deployed roles, inside transactions
 * that are always rolled back (nothing is persisted):
 *
 *   athlya_app  (DB_URL)       register → login lookup → notification
 *                              recipient → member export enqueue (tenant
 *                              GUCs) → worker claim + data → account
 *                              deletion with its event → RGPD cascade
 *   athlya_cron (CRON_DB_URL)  leased outbox claim privileges
 *
 * Usage (staging, after migrations 0031–0035):
 *   APP_DATABASE_URL=postgresql://athlya_app:...@.../athlya \
 *   CRON_DATABASE_URL=postgresql://athlya_cron:...@.../athlya \
 *   SMOKE_STUDIO_SLUG=<existing studio slug> \
 *   node scripts/verify-role-contract.mjs
 *
 * Exit 0 = every workload works under its least-privilege role.
 * See docs/runbooks/db-role-switch.md.
 */

import { randomUUID } from 'node:crypto';

/** Functions the runtime needs from migrations 0032–0036. */
export const REQUIRED_FUNCTIONS = [
  'auth_find_active_user_by_email',
  'auth_find_user_by_id',
  'auth_find_studio_by_slug',
  'auth_create_member_with_event',
  'auth_soft_delete_user_with_event',
  'auth_record_event',
  'auth_consume_password_reset',
  'notification_recipient',
  'rgpd_delete_reservations',
  'rgpd_delete_workout_sessions',
  'rgpd_delete_push_tokens',
  'rgpd_delete_idempotency_keys',
  'rgpd_restamp_user_deleted',
  'export_job_claim',
  'export_job_get',
  'export_job_profile',
  'export_job_rows',
  'billing_apply_stripe_event',
  'billing_list_invoices',
];

const ROLLBACK = Symbol('role-contract-rollback');

export class ContractError extends Error {}

function check(condition, message) {
  if (!condition) throw new ContractError(message);
}

/** Run `fn` in a transaction that is always rolled back. */
async function rolledBack(sql, fn) {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function assertNoBypass(sql, expectedRole, log) {
  const [row] = await sql`
    SELECT current_user::text AS name, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user
  `;
  check(row !== undefined, 'could not resolve current_user');
  check(row.bypass === false, `${row.name} has BYPASSRLS — wrong connection string`);
  if (expectedRole !== undefined) {
    check(row.name === expectedRole, `connected as ${row.name}, expected ${expectedRole}`);
  }
  log(`connected as ${row.name} (no BYPASSRLS)`);
}

/**
 * @param {{ app: import('postgres').Sql, cron?: import('postgres').Sql,
 *           studioSlug: string, log?: (m: string) => void }} options
 */
export async function runRoleContract({ app, cron, studioSlug, log = console.log }) {
  const ok = (m) => log(`[role-contract] OK: ${m}`);

  await assertNoBypass(app, 'athlya_app', ok);

  const fns = await app`
    SELECT proname::text AS name FROM pg_proc
     WHERE proname = ANY(${REQUIRED_FUNCTIONS}) AND has_function_privilege(oid, 'EXECUTE')
  `;
  const present = new Set(fns.map((r) => r.name));
  const missing = REQUIRED_FUNCTIONS.filter((f) => !present.has(f));
  check(missing.length === 0, `missing or not executable: ${missing.join(', ')} (apply 0032–0034)`);
  ok(`${REQUIRED_FUNCTIONS.length} service functions executable`);

  const [unscoped] = await app`SELECT count(*)::int AS n FROM users`;
  check(unscoped.n === 0, `unscoped users read returned ${unscoped.n} rows — RLS not enforced`);
  ok('raw tenant tables invisible without claims');

  await rolledBack(app, async (tx) => {
    const [studio] = await tx`SELECT id FROM auth_find_studio_by_slug(${studioSlug})`;
    check(studio !== undefined, `studio slug "${studioSlug}" not found (pre-auth lookup)`);

    const userId = randomUUID();
    const email = `role-contract+${userId}@athlya.invalid`;
    const registered = {
      id: randomUUID(),
      type: 'auth.user.registered',
      occurredAt: new Date().toISOString(),
      studioId: studio.id,
      payload: { userId },
    };
    const [created] = await tx`
      SELECT id, role FROM auth_create_member_with_event(
        ${userId}::uuid, ${studio.id}::uuid, ${email}, 'Role contract', NULL, '{}'::jsonb,
        ${JSON.stringify(registered)}::text::jsonb)
    `;
    check(created?.role === 'member', 'register (user + event) failed');
    ok('register: member + auth.user.registered recorded atomically');

    const [found] = await tx`SELECT id FROM auth_find_active_user_by_email(${email.toUpperCase()})`;
    check(found?.id === userId, 'login lookup by email failed');
    ok('login lookup (citext) works without claims');

    const [recipient] = await tx`SELECT email FROM notification_recipient(${userId}::uuid)`;
    check(recipient?.email === email, 'notification recipient lookup failed');
    ok('notification recipient resolves without claims');

    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`SELECT set_config('app.studio_id', ${studio.id}, true)`;
    await tx`SELECT set_config('app.role', 'member', true)`;
    const [own] = await tx`SELECT count(*)::int AS n FROM users`;
    check(own.n === 1, `member sees ${own.n} user rows, expected exactly their own`);
    const jobId = randomUUID();
    const requested = {
      id: randomUUID(),
      type: 'members.export.requested',
      occurredAt: new Date().toISOString(),
      payload: { userId, exportJobId: jobId },
    };
    await tx`
      WITH job AS (
        INSERT INTO export_jobs (id, user_id, status, requested_at)
        VALUES (${jobId}::uuid, ${userId}::uuid, 'pending', now()) RETURNING id
      )
      INSERT INTO outbox (event_id, event_type, payload, occurred_at)
      SELECT ${requested.id}, ${requested.type}, ${JSON.stringify(requested)}::text::jsonb, now() FROM job
    `;
    ok('member enqueues own export + outbox event under tenant claims');

    await tx`SELECT set_config('app.user_id', '', true)`;
    await tx`SELECT set_config('app.studio_id', '', true)`;
    await tx`SELECT set_config('app.role', '', true)`;
    const [claim] = await tx`SELECT export_job_claim(${jobId}::uuid) AS won`;
    check(claim.won === true, 'export worker could not claim the job');
    const [profile] = await tx`SELECT export_job_profile(${jobId}::uuid)->>'email' AS email`;
    check(profile.email === email, 'export worker could not read the claimed job data');
    await tx`SELECT * FROM export_job_rows(${jobId}::uuid, 'reservations', NULL, 10)`;
    ok('export worker claims the job and reads its data without claims');

    const deleted = {
      id: randomUUID(),
      type: 'auth.user.deleted',
      occurredAt: new Date().toISOString(),
      studioId: studio.id,
      payload: { userId },
    };
    await tx`SELECT auth_soft_delete_user_with_event(${userId}::uuid, ${JSON.stringify(deleted)}::text::jsonb)`;
    const [gone] =
      await tx`SELECT count(*)::int AS n FROM auth_find_active_user_by_email(${email})`;
    check(gone.n === 0, 'deleted account still resolves for login');
    ok('account deletion + auth.user.deleted recorded atomically');

    await tx`
      SELECT rgpd_delete_reservations(${userId}::uuid), rgpd_delete_workout_sessions(${userId}::uuid),
             rgpd_delete_push_tokens(${userId}::uuid), rgpd_delete_idempotency_keys(${userId}::uuid),
             rgpd_restamp_user_deleted(${userId}::uuid, now())
    `;
    ok('RGPD cascade functions run for the deleted account');

    await tx`SELECT * FROM billing_list_invoices(${studio.id}::uuid, NULL, NULL, 1)`;
    ok('billing invoice listing runs without claims');
  });
  ok('app workloads rolled back — nothing persisted');

  if (cron === undefined) {
    log('[role-contract] SKIP: CRON_DATABASE_URL not set — drainer role not verified');
    return { cronVerified: false };
  }

  await assertNoBypass(cron, 'athlya_cron', ok);
  await rolledBack(cron, async (tx) => {
    await tx`
      WITH claimed AS (
        SELECT id FROM outbox
         WHERE published_at IS NULL
           AND (lease_until IS NULL OR lease_until <= now())
           AND event_type = 'role.contract.none'
         ORDER BY occurred_at LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox SET attempts = outbox.attempts + 1,
                        lease_until = now() + make_interval(secs => 120)
        FROM claimed WHERE outbox.id = claimed.id
    `;
    await tx`
      UPDATE outbox SET published_at = now(), lease_until = NULL
       WHERE id = ANY(${'{}'}::uuid[])
    `;
    await tx`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`;
  });
  ok('drainer: leased claim, publish stamp and backlog count privileges');
  return { cronVerified: true };
}

if (import.meta.main) {
  const appUrl = process.env.APP_DATABASE_URL ?? '';
  const cronUrl = process.env.CRON_DATABASE_URL ?? '';
  const studioSlug = process.env.SMOKE_STUDIO_SLUG ?? '';
  if (appUrl === '' || studioSlug === '') {
    console.error('[role-contract] APP_DATABASE_URL and SMOKE_STUDIO_SLUG are required');
    process.exit(1);
  }
  // `postgres` is a dependency of @athlya/db, not of the workspace root.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const fromDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const { default: postgres } = await import(pathToFileURL(fromDb.resolve('postgres')).href);
  const app = postgres(appUrl, { max: 1, prepare: false, onnotice: () => {} });
  const cron =
    cronUrl === '' ? undefined : postgres(cronUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await runRoleContract({ app, cron, studioSlug });
    console.log('[role-contract] all checks passed');
  } catch (err) {
    console.error(`[role-contract] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await app.end({ timeout: 2 });
    await cron?.end({ timeout: 2 });
  }
}
