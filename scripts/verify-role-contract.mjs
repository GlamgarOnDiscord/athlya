#!/usr/bin/env node
/**
 * Runtime role contract (issue #117) — replays every claim-less and
 * tenant workload against the REAL deployed roles, inside transactions
 * that are always rolled back (nothing is persisted):
 *
 *   athlya_app  (DB_URL)       tenant slug resolution → register → login
 *                              lookup → notification recipient → password
 *                              reset issue + lookup + consume → reset
 *                              request outbox event → idempotency keys
 *                              (refused without claims, replayed with
 *                              them) → own studio
 *                              read + admin branding update and member export
 *                              enqueue (tenant GUCs) → worker claim + data +
 *                              complete → account deletion with its event →
 *                              RGPD cascade (incl. audit anonymisation) →
 *                              book, waitlist position, cancel with
 *                              waitlist promotion (member claims)
 *   athlya_cron (CRON_DB_URL)  leased outbox claim privileges, capacity
 *                              reconcile snapshot, RGPD user anonymisation
 *   athlya_billing             Stripe event application (the only role
 *     (BILLING_DB_URL)         allowed to; athlya_app is refused)
 *
 * Usage (staging, after migrations 0031–0041):
 *   APP_DATABASE_URL=postgresql://athlya_app:...@.../athlya \
 *   CRON_DATABASE_URL=postgresql://athlya_cron:...@.../athlya \
 *   BILLING_DATABASE_URL=postgresql://athlya_billing:...@.../athlya \
 *   SMOKE_STUDIO_SLUG=<existing studio slug> \
 *   node scripts/verify-role-contract.mjs
 *
 * All four variables are required; a superuser or BYPASSRLS connection
 * fails the contract. Exit 0 = every workload works under its least-privilege role.
 * See docs/runbooks/db-role-switch.md.
 */

import { randomUUID } from 'node:crypto';

/** Functions athlya_app needs from migrations 0032–0040. */
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
  'export_job_complete',
  'export_job_fail',
  'export_job_get',
  'export_job_profile',
  'export_job_rows',
  'billing_list_invoices',
  'studio_id_by_slug',
  'auth_issue_password_reset',
  'auth_find_password_reset',
  'auth_request_password_reset',
  'rgpd_anonymize_user_audit',
  'reservation_lock_class_for_cancel',
  'reservation_promote_oldest_waitlist',
  'reservation_waitlist_ahead',
];

/** Stripe event application: athlya_billing only (migration 0036). */
const BILLING_APPLY = 'billing_apply_stripe_event(text, text, jsonb)';

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
    SELECT current_user::text AS name, rolbypassrls AS bypass, rolsuper AS super
      FROM pg_roles WHERE rolname = current_user
  `;
  check(row !== undefined, 'could not resolve current_user');
  check(row.super === false, `${row.name} is a superuser (bypasses RLS) — wrong connection string`);
  check(row.bypass === false, `${row.name} has BYPASSRLS — wrong connection string`);
  if (expectedRole !== undefined) {
    check(row.name === expectedRole, `connected as ${row.name}, expected ${expectedRole}`);
  }
  log(`connected as ${row.name} (no SUPERUSER, no BYPASSRLS)`);
}

/**
 * @param {{ app: import('postgres').Sql, cron: import('postgres').Sql,
 *           billing: import('postgres').Sql,
 *           studioSlug: string, log?: (m: string) => void }} options
 */
export async function runRoleContract({ app, cron, billing, studioSlug, log = console.log }) {
  const ok = (m) => log(`[role-contract] OK: ${m}`);
  check(cron !== undefined, 'CRON_DATABASE_URL is required: the drainer role must be verified');
  check(
    billing !== undefined,
    'BILLING_DATABASE_URL is required: the Stripe webhook role must be verified',
  );

  await assertNoBypass(app, 'athlya_app', ok);

  const fns = await app`
    SELECT proname::text AS name FROM pg_proc
     WHERE proname = ANY(${REQUIRED_FUNCTIONS}) AND has_function_privilege(oid, 'EXECUTE')
  `;
  const present = new Set(fns.map((r) => r.name));
  const missing = REQUIRED_FUNCTIONS.filter((f) => !present.has(f));
  check(missing.length === 0, `missing or not executable: ${missing.join(', ')} (apply 0032–0040)`);
  ok(`${REQUIRED_FUNCTIONS.length} service functions executable`);

  const [forge] = await app`SELECT has_function_privilege(${BILLING_APPLY}, 'EXECUTE') AS can`;
  check(forge.can === false, 'athlya_app can apply Stripe events — revoke it (migration 0036)');
  ok('athlya_app cannot apply Stripe events');

  const [unscoped] = await app`SELECT count(*)::int AS n FROM users`;
  check(unscoped.n === 0, `unscoped users read returned ${unscoped.n} rows — RLS not enforced`);
  ok('raw tenant tables invisible without claims');

  await rolledBack(app, async (tx) => {
    const [studio] = await tx`SELECT id FROM auth_find_studio_by_slug(${studioSlug})`;
    check(studio !== undefined, `studio slug "${studioSlug}" not found (pre-auth lookup)`);
    const [resolved] = await tx`SELECT studio_id_by_slug(${studioSlug}) AS id`;
    check(resolved?.id === studio.id, 'tenant slug guard could not resolve the studio id');
    ok('tenant slug guard resolves the studio id without claims');

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

    const tokenHash = randomUUID().replaceAll('-', '').repeat(2);
    const [issued] = await tx`
      SELECT auth_issue_password_reset(${userId}::uuid, ${tokenHash}, now() + interval '1 hour') AS ok
    `;
    check(issued.ok === true, 'password reset token could not be issued');
    const [active] = await tx`SELECT user_id FROM auth_find_password_reset(${tokenHash})`;
    check(active?.user_id === userId, 'issued password reset token not found');
    const consumed = await tx`
      SELECT id FROM auth_consume_password_reset(${tokenHash}, ${userId}::uuid, 'role-contract-hash') AS id
    `;
    check(consumed.length === 1, 'password reset token could not be consumed');
    ok('password reset: issue, lookup and consume work without claims');

    const [resetRequest] = await tx`
      SELECT auth_request_password_reset(${email.toUpperCase()}, ${randomUUID()}::uuid) AS enqueued
    `;
    check(
      resetRequest.enqueued === true,
      'password reset request was not recorded for a live account',
    );
    const [unknownReset] = await tx`
      SELECT auth_request_password_reset(${`unknown+${userId}@athlya.invalid`}, ${randomUUID()}::uuid) AS enqueued
    `;
    check(unknownReset.enqueued === false, 'password reset request recorded for an unknown address');
    ok('password reset request: outbox event recorded without claims, none for an unknown address');

    const idemKey = `role-contract-${randomUUID()}`;
    const claimless = await tx
      .savepoint(
        (sp) => sp`
          INSERT INTO idempotency_keys (key, user_id, response, status_code, expires_at)
          VALUES (${idemKey}, ${userId}::uuid, '{}'::jsonb, 200, now() + interval '1 minute')
        `,
      )
      .then(
        () => 'stored',
        (err) => err.code,
      );
    check(claimless === '42501', `claim-less idempotency store was not refused (${claimless})`);
    ok('idempotency keys: a store without the caller claims is refused');

    await tx`
      INSERT INTO audit_log (actor_id, action, metadata)
      VALUES (${userId}::uuid, 'role.contract', ${JSON.stringify({ email })}::text::jsonb)
    `;
    const [liveAudit] = await tx`SELECT rgpd_anonymize_user_audit(${userId}::uuid) AS n`;
    check(liveAudit.n === 0, 'audit rows of a live account were anonymised');

    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`SELECT set_config('app.studio_id', ${studio.id}, true)`;
    await tx`SELECT set_config('app.role', 'member', true)`;
    const [own] = await tx`SELECT count(*)::int AS n FROM users`;
    check(own.n === 1, `member sees ${own.n} user rows, expected exactly their own`);
    await tx`
      INSERT INTO idempotency_keys (key, user_id, response, status_code, expires_at)
      VALUES (${idemKey}, ${userId}::uuid, '{"deleted":true}'::jsonb, 200, now() + interval '1 minute')
    `;
    const [replay] = await tx`
      SELECT count(*)::int AS n FROM idempotency_keys WHERE key = ${idemKey} AND user_id = ${userId}::uuid
    `;
    check(replay.n === 1, 'idempotency key not replayable under the caller claims');
    ok('idempotency keys: stored and replayed under the caller claims');
    const [ownStudio] = await tx`SELECT count(*)::int AS n FROM studios`;
    check(ownStudio.n === 1, `member sees ${ownStudio.n} studios rows, expected exactly their own`);
    const memberEdit =
      await tx`UPDATE studios SET name = name WHERE id = ${studio.id}::uuid RETURNING id`;
    check(memberEdit.length === 0, 'a member could update the studio branding');
    await tx`SELECT set_config('app.role', 'admin', true)`;
    const adminEdit =
      await tx`UPDATE studios SET name = name WHERE id = ${studio.id}::uuid RETURNING id`;
    check(adminEdit.length === 1, 'a studio admin could not update the studio branding');
    await tx`SELECT set_config('app.role', 'member', true)`;
    ok('studio read is tenant-scoped; only an admin updates the branding');
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
    const [claim] = await tx`SELECT export_job_claim(${jobId}::uuid)::text AS token`;
    check(claim.token !== null, 'export worker could not claim the job');
    const [profile] = await tx`SELECT export_job_profile(${jobId}::uuid)->>'email' AS email`;
    check(profile.email === email, 'export worker could not read the claimed job data');
    await tx`SELECT * FROM export_job_rows(${jobId}::uuid, 'reservations', NULL, 10)`;
    ok('export worker claims the job and reads its data without claims');

    const [stale] = await tx`
      SELECT export_job_fail(${jobId}::uuid, ${randomUUID()}::uuid, 'role contract') AS ok
    `;
    check(stale.ok === false, 'export_job_fail accepted a stale claim token');
    const [done] = await tx`
      SELECT export_job_complete(${jobId}::uuid, ${claim.token}::uuid,
                                 'https://role-contract.invalid/export.zip',
                                 now() + interval '1 hour') AS ok
    `;
    check(done.ok === true, 'export worker could not complete the claimed job');
    const [failed] = await tx`
      SELECT export_job_fail(${jobId}::uuid, ${claim.token}::uuid, 'role contract') AS ok
    `;
    check(failed.ok === false, 'export_job_fail changed a completed job');
    ok('export worker completes under its claim token; stale or late fail is a no-op');

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
    const [anonymised] = await tx`SELECT rgpd_anonymize_user_audit(${userId}::uuid) AS n`;
    check(anonymised.n >= 1, 'audit rows of the deleted account were not anonymised');
    ok('RGPD cascade functions run for the deleted account, audit rows anonymised');

    const invoices =
      await tx`SELECT * FROM billing_list_invoices(${studio.id}::uuid, NULL, NULL, 1)`;
    check(invoices.length === 0, 'billing invoices visible without tenant claims');
    ok('billing invoice listing runs and is RLS-scoped');
  });
  ok('app workloads rolled back — nothing persisted');

  await rolledBack(app, async (tx) => {
    await runWaitlistContract(tx, studioSlug, ok);
  });
  ok('waitlist workloads rolled back — nothing persisted');

  await assertNoBypass(billing, 'athlya_billing', ok);
  await rolledBack(billing, async (tx) => {
    const eventId = `evt_role_contract_${randomUUID()}`;
    const [first] =
      await tx`SELECT billing_apply_stripe_event(${eventId}, 'role.contract', '{}'::jsonb) AS applied`;
    const [replay] =
      await tx`SELECT billing_apply_stripe_event(${eventId}, 'role.contract', '{}'::jsonb) AS applied`;
    check(first.applied === true && replay.applied === false, 'Stripe event claim/replay failed');
  });
  ok('Stripe webhook: event applied once, replay is a no-op');

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

  await rolledBack(cron, async (tx) => {
    await tx`SELECT class_id, capacity, confirmed FROM capacity_reconcile_snapshot()`;
  });
  ok('capacity reconcile: cross-tenant snapshot through capacity_reconcile_snapshot()');

  await rolledBack(cron, async (tx) => {
    const [column] = await tx`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
    `;
    check(
      column?.is_nullable === 'YES',
      'users.email is NOT NULL: the RGPD purge fails with 23502 (apply 0041)',
    );

    // Target: the oldest expired soft-deleted user when there is one.
    // Otherwise a user with an email (soft-deleted first) is backdated
    // past the window inside this transaction, so the purge always has
    // a known row to anonymise. Everything is rolled back.
    let [target] = await tx`
      SELECT id FROM users
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - interval '30 days'
         AND email IS NOT NULL
       ORDER BY deleted_at ASC
       LIMIT 1
    `;
    if (target === undefined) {
      [target] = await tx`
        SELECT id FROM users WHERE email IS NOT NULL
         ORDER BY deleted_at IS NULL, id
         LIMIT 1
      `;
      check(target !== undefined, 'no user to replay the RGPD purge on');
      await tx`
        UPDATE users SET deleted_at = timestamptz '2000-01-01 00:00:00+00'
         WHERE id = ${target.id}::uuid
      `;
    }

    const anonymised = await tx`
      WITH expired AS (
        SELECT id FROM users
         WHERE deleted_at IS NOT NULL
           AND deleted_at < now() - interval '30 days'
           AND email IS NOT NULL
         ORDER BY deleted_at ASC
         LIMIT 1
      )
      UPDATE users
         SET email = NULL, display_name = '[deleted]', avatar_url = NULL,
             consents = '{}'::jsonb, password_hash = NULL
       WHERE id IN (SELECT id FROM expired)
      RETURNING id
    `;
    check(
      anonymised.length === 1 && anonymised[0].id === target.id,
      'RGPD purge as athlya_cron did not anonymise the expired user (RLS or grants)',
    );
    const [after] = await tx`
      SELECT email, display_name FROM users WHERE id = ${target.id}::uuid
    `;
    check(
      after?.email === null && after.display_name === '[deleted]',
      'RGPD purge left PII on the expired user',
    );
  });
  ok('RGPD purge: an expired soft-deleted user is anonymised as athlya_cron (migration 0041)');
}

/**
 * Book → waitlist → cancel with promotion, as members of the smoke
 * studio under `athlya_app` (migration 0040). Three throwaway members;
 * a studio admin claim creates a one-seat class.
 */
async function runWaitlistContract(tx, studioSlug, ok) {
  const [studio] = await tx`SELECT id FROM auth_find_studio_by_slug(${studioSlug})`;
  check(studio !== undefined, `studio slug "${studioSlug}" not found (pre-auth lookup)`);

  const claims = async (userId, role) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`SELECT set_config('app.studio_id', ${studio.id}, true)`;
    await tx`SELECT set_config('app.role', ${role}, true)`;
  };
  const member = async () => {
    const userId = randomUUID();
    const event = {
      id: randomUUID(),
      type: 'auth.user.registered',
      occurredAt: new Date().toISOString(),
      studioId: studio.id,
      payload: { userId },
    };
    await tx`
      SELECT id FROM auth_create_member_with_event(
        ${userId}::uuid, ${studio.id}::uuid, ${`role-contract+${userId}@athlya.invalid`},
        'Role contract', NULL, '{}'::jsonb, ${JSON.stringify(event)}::text::jsonb)
    `;
    return userId;
  };
  const [first, second, third] = [await member(), await member(), await member()];

  await claims(first, 'admin');
  const [cls] = await tx`
    INSERT INTO classes (studio_id, title, starts_at, duration_min, capacity)
    VALUES (${studio.id}::uuid, 'Role contract', now() + interval '7 days', 60, 1)
    RETURNING id
  `;

  await claims(first, 'member');
  await tx`INSERT INTO reservations (class_id, user_id, status) VALUES (${cls.id}::uuid, ${first}::uuid, 'confirmed')`;
  await claims(second, 'member');
  await tx`
    INSERT INTO reservations (class_id, user_id, status, created_at)
    VALUES (${cls.id}::uuid, ${second}::uuid, 'waitlist', now() - interval '2 seconds')
  `;
  await claims(third, 'member');
  const [last] = await tx`
    INSERT INTO reservations (class_id, user_id, status, created_at)
    VALUES (${cls.id}::uuid, ${third}::uuid, 'waitlist', now() - interval '1 second')
    RETURNING id::text AS id
  `;
  const [ahead] = await tx`
    SELECT reservation_waitlist_ahead(${cls.id}::uuid, ${last.id}::uuid) AS n
  `;
  check(ahead.n === 1, `waitlist position counted ${ahead.n} members ahead, expected 1`);
  ok('waitlist position counts the other members under member claims');

  await claims(first, 'member');
  const [lock] = await tx`SELECT reservation_lock_class_for_cancel(${cls.id}::uuid) AS starts_at`;
  check(lock.starts_at !== null, 'a member could not lock the class to cancel');
  await tx`
    UPDATE reservations SET status = 'cancelled', cancelled_at = now()
     WHERE class_id = ${cls.id}::uuid AND user_id = ${first}::uuid
  `;
  const [promotion] = await tx`
    SELECT outcome, user_id::text AS user_id
      FROM reservation_promote_oldest_waitlist(${cls.id}::uuid)
  `;
  check(
    promotion.outcome === 'promoted' && promotion.user_id === second,
    `cancellation promoted ${promotion.outcome}/${promotion.user_id}, expected the oldest waiter`,
  );
  await tx`
    INSERT INTO outbox (event_id, event_type, payload, occurred_at)
    VALUES (${randomUUID()}, 'reservation.promoted', '{}'::jsonb, now())
  `;
  ok('member cancellation locks the class and promotes the oldest waiter with its event');

  const [full] = await tx`SELECT outcome FROM reservation_promote_oldest_waitlist(${cls.id}::uuid)`;
  check(full.outcome === 'no_capacity', `second promotion returned ${full.outcome}`);
  ok('promotion respects capacity');
}

if (import.meta.main) {
  const appUrl = process.env.APP_DATABASE_URL ?? '';
  const cronUrl = process.env.CRON_DATABASE_URL ?? '';
  const billingUrl = process.env.BILLING_DATABASE_URL ?? '';
  const studioSlug = process.env.SMOKE_STUDIO_SLUG ?? '';
  if (appUrl === '' || cronUrl === '' || billingUrl === '' || studioSlug === '') {
    console.error(
      '[role-contract] APP_DATABASE_URL, CRON_DATABASE_URL, BILLING_DATABASE_URL and SMOKE_STUDIO_SLUG are required',
    );
    process.exit(1);
  }
  // `postgres` is a dependency of @athlya/db, not of the workspace root.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const fromDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const { default: postgres } = await import(pathToFileURL(fromDb.resolve('postgres')).href);
  const app = postgres(appUrl, { max: 1, prepare: false, onnotice: () => {} });
  const cron = postgres(cronUrl, { max: 1, prepare: false, onnotice: () => {} });
  const billing = postgres(billingUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await runRoleContract({ app, cron, billing, studioSlug });
    console.log('[role-contract] all checks passed');
  } catch (err) {
    console.error(`[role-contract] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await app.end({ timeout: 2 });
    await cron.end({ timeout: 2 });
    await billing.end({ timeout: 2 });
  }
}
