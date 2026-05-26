/**
 * Integration test for the RGPD deletion cascade — Property 4 (task 5.6).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 *
 * What this suite asserts
 * -----------------------
 * The production `handleUserDeleted` + `anonymizeAuditLog` exports from
 * `@athlya/members/cascade` (task 5.4) are exercised VERBATIM against a
 * real Postgres 17 instance spun up through Testcontainers with
 * migrations `0000_init.sql`, `0001_rls.sql` and `0002_export_jobs.sql`
 * applied end-to-end. No re-implementation of the cascade lives in this
 * file — the ports declared by `cascade.ts` (`DeletionRepo`,
 * `AvatarStore`, `Scheduler`) are wired to production-shaped adapters
 * over Drizzle + plain `postgres-js` SQL, so every assertion reflects
 * the exact code path that will run on the worker at deploy time.
 *
 * Property 4 — "RGPD cascade (full deletion)" — reduces to three
 * invariants:
 *
 *   1. (Req 5.2, 5.4) Calling `deleteMe` (modelled here by the
 *      `auth.user.deleted` consumer) removes every row referencing
 *      Alice from `reservations`, `workout_sessions` and
 *      `push_tokens`, stamps `users.deleted_at` and best-effort
 *      purges the R2 avatar. Other users' data (Bob in a DIFFERENT
 *      studio) is untouched.
 *   2. (Req 5.3) A delayed anonymisation job runs 30 days after
 *      `deleted_at`: on every `audit_log` row with `actor_id =
 *      alice.id`, `actor_id` becomes NULL and the PII keys
 *      `email` / `displayName` / `ip` / `userAgent` are stripped from
 *      the `metadata` JSON while non-PII keys survive untouched.
 *   3. (Req 5.3, contract JSDoc of `anonymizeAuditLog`) The
 *      anonymisation is idempotent: a second invocation finds zero
 *      matching rows and returns `anonymizedRows === 0`.
 *
 * Additionally (contract of `handleUserDeleted`), a scheduler failure
 * rethrows to the caller so the event bus redelivers the cascade —
 * but the SQL-side deletions have already landed, matching the
 * idempotent-retry posture documented in `cascade.ts`.
 *
 * Docker-skip pattern
 * -------------------
 * Testcontainers spins up a real Postgres container. On machines
 * without a running Docker daemon the `PostgreSqlContainer#start()`
 * call fails with an opaque ECONNREFUSED 15–60 s later. To keep the
 * package test suite green on such machines we perform a synchronous
 * `docker info` probe at module load (identical to the pattern used
 * by `packages/db/tests/properties/rls.property.test.ts`) and gate
 * the entire describe block behind `describe.skipIf(!dockerReady)`.
 * An always-registered "infra probe" describe asserts the test file
 * itself loads cleanly, so a broken import surfaces in CI even when
 * Docker is absent.
 *
 * audit_log immutability workaround
 * ---------------------------------
 * Migration 0003 rewrites `audit_log_immutable()` to allow mutations
 * only when `current_user = 'athlya_owner'`. `anonymizeAuditRows`
 * delegates to the SECURITY DEFINER function `anonymize_user_audit(uuid)`
 * (0003+0006) which runs as `athlya_owner` and therefore satisfies the
 * trigger check. All migrations 0000-0006 are applied in beforeAll so the
 * function and its scalar guard are available.
 *
 * RLS posture
 * -----------
 * The cascade has no tenant scope: by the time the worker runs, the
 * user has been soft-deleted and deletion is intentionally
 * cross-studio at the user-id level. The DeletionRepo adapter
 * therefore opens its connection under a BYPASSRLS superuser role
 * rather than going through `withTenant`. This matches the production
 * contract described in `cascade.ts` ("a service-level connection
 * that handles multiple tenants during the consumer flow").
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  anonymizeAuditLog,
  handleUserDeleted,
  type AvatarStore,
  type Clock,
  type DeletionRepo,
  type Scheduler,
} from '../../src/cascade.js';

import type { AuthUserDeletedEvent } from '@athlya/shared/events';
import type { PGlite } from '@electric-sql/pglite';
import type { Sql } from 'postgres';

/* ================================================================= */
/*  Docker-daemon availability probe                                  */
/*                                                                    */
/*  Synchronous at module load so `describe.skipIf` sees the flag      */
/*  before tests are registered. Same implementation as the one in    */
/*  `packages/db/tests/properties/rls.property.test.ts`.               */
/* ================================================================= */

function detectDocker(): boolean {
  try {
    const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf8',
    });
    return res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const dockerReady = detectDocker();

/* ================================================================= */
/*  Shared container state                                             */
/* ================================================================= */

let container: { stop: () => Promise<void> } | null = null;

/** Superuser (BYPASSRLS + table owner) client. Used by the seed   */
/** helpers and by every DeletionRepo adapter built in this suite. */
let rootClient: Sql | null = null;

/** PGlite instance — populated in beforeAll when Docker is unreachable (CN.9.3). */
let pglite: PGlite | null = null;

const ROOT_ROLE = 'postgres';

/* ================================================================= */
/*  Migration plumbing                                                 */
/*                                                                    */
/*  `postgres-js` speaks the extended query protocol and refuses       */
/*  multi-statement strings, so we split the drizzle-kit-emitted       */
/*  migrations on the `--> statement-breakpoint` marker and send each  */
/*  fragment separately via `sql.unsafe()`. Copied verbatim from       */
/*  `packages/db/tests/properties/rls.property.test.ts`.               */
/* ================================================================= */

async function applyMigration(client: Sql, sqlText: string): Promise<void> {
  const statements = sqlText
    .split(/-->\s*statement-breakpoint/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  for (const stmt of statements) {
    await client.unsafe(stmt);
  }
}

function readMigration(name: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // tests/integration -> packages/members/tests/integration; the db
  // migrations live at ../../../db/migrations relative to this file.
  const file = resolve(here, '..', '..', '..', 'db', 'migrations', name);
  return readFileSync(file, 'utf8');
}

/* ================================================================= */
/*  Test fixtures                                                      */
/*                                                                    */
/*  Fixed UUIDs so the SQL assertions produce legible counter-examples */
/*  in the rare case one fails. Alice lives in studio "alpha"; Bob     */
/*  lives in studio "bravo" — the cascade MUST NOT touch any Bob row.  */
/* ================================================================= */

const STUDIO_ALPHA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_BRAVO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';

const CLASS_A1 = 'c1111111-1111-4111-8111-111111111111';
const CLASS_A2 = 'c2222222-2222-4222-8222-222222222222';
const CLASS_A3 = 'c3333333-3333-4333-8333-333333333333';
const CLASS_B1 = 'cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Frozen wall-clock instant fed to the cascade's clock port. */
const TIME_0_MS = Date.parse('2026-02-01T10:00:00.000Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_CONSENTS = {
  marketing: false,
  analytics: false,
  thirdParty: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
};

/** Build the `auth.user.deleted` envelope targeting Alice. */
function buildEvent(userId: string): AuthUserDeletedEvent {
  return {
    id: EVENT_ID,
    type: 'auth.user.deleted',
    occurredAt: '2026-02-01T09:59:00.000Z',
    studioId: STUDIO_ALPHA_ID as AuthUserDeletedEvent['studioId'],
    payload: {
      userId: userId as AuthUserDeletedEvent['payload']['userId'],
    },
  };
}

/* ================================================================= */
/*  Production-shaped ports over `postgres-js` / in-memory fakes       */
/* ================================================================= */

/**
 * DeletionRepo wired to a real Postgres client. Every method is a
 * single SQL statement matching the shape documented in the repo's
 * JSDoc (see `packages/members/src/cascade.ts`). The audit
 * anonymisation method uses the trigger-relaxation sequence described
 * in the suite preamble.
 */
function buildRepo(client: Sql): DeletionRepo {
  return {
    async deleteReservationsForUser(userId) {
      const rows = await client<{ id: string }[]>`
                DELETE FROM reservations
                 WHERE user_id = ${userId}
                 RETURNING id
            `;
      return rows.length;
    },
    async deleteWorkoutSessionsForUser(userId) {
      const rows = await client<{ id: string }[]>`
                DELETE FROM workout_sessions
                 WHERE user_id = ${userId}
                 RETURNING id
            `;
      return rows.length;
    },
    async deletePushTokensForUser(userId) {
      const rows = await client<{ id: string }[]>`
                DELETE FROM push_tokens
                 WHERE user_id = ${userId}
                 RETURNING id
            `;
      return rows.length;
    },
    async deleteIdempotencyKeysForUser(userId) {
      const rows = await client<{ key: string }[]>`
                DELETE FROM idempotency_keys
                 WHERE user_id = ${userId}
                 RETURNING key
            `;
      return rows.length;
    },
    async markUserDeleted(userId, deletedAt) {
      await client`
                UPDATE users
                   SET deleted_at = ${deletedAt}
                 WHERE id = ${userId}
            `;
    },
    async anonymizeAuditRows(userId) {
      // Delegate to the SECURITY DEFINER function (0003+0006) — runs as
      // `athlya_owner`, satisfying the trigger's current_user check.
      const [row] = await client.unsafe<{ n: number }[]>(`SELECT anonymize_user_audit($1) AS n`, [
        userId,
      ]);
      return Number(row?.n ?? 0);
    },
  };
}

/** In-memory AvatarStore recording per-user deletions. */
function buildAvatars(initial: Record<string, Uint8Array> = {}): {
  avatars: AvatarStore;
  store: Map<string, Uint8Array>;
} {
  const store = new Map<string, Uint8Array>(Object.entries(initial));
  const avatars: AvatarStore = {
    deleteAvatar(userId) {
      store.delete(userId);
      return Promise.resolve();
    },
  };
  return { avatars, store };
}

/** In-memory scheduler recording every (userId, dueAt) pair. */
interface ScheduledJob {
  readonly userId: string;
  readonly dueAt: Date;
}

function buildScheduler(): {
  scheduler: Scheduler;
  jobs: ScheduledJob[];
} {
  const jobs: ScheduledJob[] = [];
  const scheduler: Scheduler = {
    scheduleAnonymization(userId, dueAt) {
      jobs.push({ userId, dueAt });
      return Promise.resolve();
    },
  };
  return { scheduler, jobs };
}

/** Frozen clock. Instances are cheap so each test makes its own. */
function buildClock(now: number): Clock {
  return { now: () => now };
}

// -----------------------------------------------------------------
// PGlite helpers (CN.9.3) — raw parameterized queries instead of
// postgres-js template literals. pglite.query<T>(sql, params)
// returns { rows: T[] }.
// -----------------------------------------------------------------

async function truncateAllPglite(pg: PGlite): Promise<void> {
  await pg.exec(`
    ALTER TABLE audit_log DISABLE TRIGGER audit_log_forbid_delete;
    TRUNCATE TABLE
        export_jobs,
        push_tokens,
        idempotency_keys,
        outbox,
        audit_log,
        workout_sessions,
        reservations,
        classes,
        users,
        studios
    RESTART IDENTITY CASCADE;
    ALTER TABLE audit_log ENABLE TRIGGER audit_log_forbid_delete;
  `);
}

async function seedScenarioPglite(
  pg: PGlite,
): Promise<{ aliceAuditIds: string[]; bobAuditIds: string[] }> {
  const consents = JSON.stringify(DEFAULT_CONSENTS);

  await pg.query(
    `INSERT INTO studios (id, slug, name, brand_color) VALUES ($1, 'alpha', 'Studio Alpha', '#0EA5E9'), ($2, 'bravo', 'Studio Bravo', '#F97316')`,
    [STUDIO_ALPHA_ID, STUDIO_BRAVO_ID],
  );
  await pg.query(
    `INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES ($1, $2, 'alice@athlya.test', 'Alice', 'member', $3::jsonb), ($4, $5, 'bob@athlya.test', 'Bob', 'member', $3::jsonb)`,
    [ALICE_ID, STUDIO_ALPHA_ID, consents, BOB_ID, STUDIO_BRAVO_ID],
  );
  await pg.query(
    `INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES ($1, $2, 'Yoga Flow', '2026-03-01T09:00:00Z', 60, 20, 0), ($3, $2, 'HIIT', '2026-03-01T18:00:00Z', 45, 15, 0), ($4, $2, 'Pilates', '2026-03-02T09:00:00Z', 60, 18, 0), ($5, $6, 'Muay Thai', '2026-03-01T19:00:00Z', 60, 12, 0)`,
    [CLASS_A1, STUDIO_ALPHA_ID, CLASS_A2, CLASS_A3, CLASS_B1, STUDIO_BRAVO_ID],
  );
  await pg.query(
    `INSERT INTO reservations (class_id, user_id, status) VALUES ($1, $2, 'confirmed'), ($3, $2, 'waitlist'), ($4, $2, 'cancelled'), ($5, $6, 'confirmed')`,
    [CLASS_A1, ALICE_ID, CLASS_A2, CLASS_A3, CLASS_B1, BOB_ID],
  );
  const emptyExercises = JSON.stringify([]);
  await pg.query(
    `INSERT INTO workout_sessions (user_id, studio_id, started_at, duration_min, exercises) VALUES ($1, $2, '2026-01-15T08:00:00Z', 60, $3::jsonb), ($1, $2, '2026-01-20T08:00:00Z', 45, $3::jsonb), ($4, $5, '2026-01-18T08:00:00Z', 60, $3::jsonb)`,
    [ALICE_ID, STUDIO_ALPHA_ID, emptyExercises, BOB_ID, STUDIO_BRAVO_ID],
  );
  await pg.query(
    `INSERT INTO push_tokens (user_id, platform, token) VALUES ($1, 'ios', 'ExpoPushToken[alice-ios-1]'), ($1, 'ios', 'ExpoPushToken[alice-ios-2]'), ($1, 'android', 'ExpoPushToken[alice-android-1]'), ($1, 'web', 'ExpoPushToken[alice-web-1]'), ($2, 'ios', 'ExpoPushToken[bob-ios-1]')`,
    [ALICE_ID, BOB_ID],
  );

  const aliceMeta = [
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.7',
      userAgent: 'AthlyaMobile/1.2 (iPhone 15; iOS 17)',
      classId: CLASS_A1,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.7',
      userAgent: 'AthlyaMobile/1.2 (iPhone 15; iOS 17)',
      classId: CLASS_A2,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.8',
      userAgent: 'AthlyaWeb/1.0 (Firefox 120; macOS)',
      classId: CLASS_A3,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.9',
      userAgent: 'AthlyaWeb/1.0 (Chrome 120; Windows)',
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.9',
      userAgent: 'AthlyaWeb/1.0 (Chrome 120; Windows)',
    },
  ];
  const bobMeta = [
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.4',
      userAgent: 'AthlyaMobile/1.2 (Pixel 8; Android 14)',
      classId: CLASS_B1,
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.4',
      userAgent: 'AthlyaMobile/1.2 (Pixel 8; Android 14)',
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.5',
      userAgent: 'AthlyaWeb/1.0 (Safari 17; iPadOS)',
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.5',
      userAgent: 'AthlyaWeb/1.0 (Safari 17; iPadOS)',
    },
    { email: 'bob@athlya.test', displayName: 'Bob', ip: '198.51.100.6', userAgent: 'curl/8.5.0' },
  ];

  const aliceActions = [
    'user.login',
    'reservation.created',
    'reservation.cancelled',
    'user.consents.updated',
    'user.profile.updated',
  ];
  const aliceTargets = [ALICE_ID, CLASS_A1, CLASS_A3, ALICE_ID, ALICE_ID];
  const aliceAuditIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'user', $3, $4::jsonb) RETURNING id::text`,
      [ALICE_ID, aliceActions[i], aliceTargets[i], JSON.stringify(aliceMeta[i])],
    );
    aliceAuditIds.push(r.rows[0]!.id);
  }

  const bobActions = [
    'user.login',
    'reservation.created',
    'user.consents.updated',
    'user.profile.updated',
    'user.login',
  ];
  const bobTargets = [BOB_ID, CLASS_B1, BOB_ID, BOB_ID, BOB_ID];
  const bobAuditIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'user', $3, $4::jsonb) RETURNING id::text`,
      [BOB_ID, bobActions[i], bobTargets[i], JSON.stringify(bobMeta[i])],
    );
    bobAuditIds.push(r.rows[0]!.id);
  }

  return { aliceAuditIds, bobAuditIds };
}

function buildRepoPglite(pg: PGlite): DeletionRepo {
  return {
    async deleteReservationsForUser(userId) {
      const r = await pg.query<{ id: string }>(
        `DELETE FROM reservations WHERE user_id = $1 RETURNING id`,
        [userId],
      );
      return r.rows.length;
    },
    async deleteWorkoutSessionsForUser(userId) {
      const r = await pg.query<{ id: string }>(
        `DELETE FROM workout_sessions WHERE user_id = $1 RETURNING id`,
        [userId],
      );
      return r.rows.length;
    },
    async deletePushTokensForUser(userId) {
      const r = await pg.query<{ id: string }>(
        `DELETE FROM push_tokens WHERE user_id = $1 RETURNING id`,
        [userId],
      );
      return r.rows.length;
    },
    async deleteIdempotencyKeysForUser(userId) {
      const r = await pg.query<{ key: string }>(
        `DELETE FROM idempotency_keys WHERE user_id = $1 RETURNING key`,
        [userId],
      );
      return r.rows.length;
    },
    async markUserDeleted(userId, deletedAt) {
      await pg.query(`UPDATE users SET deleted_at = $1 WHERE id = $2`, [deletedAt, userId]);
    },
    async anonymizeAuditRows(userId) {
      const r = await pg.query<{ n: number }>(`SELECT anonymize_user_audit($1) AS n`, [userId]);
      return Number(r.rows[0]?.n ?? 0);
    },
  };
}

/**
 * Unified query helper: routes to postgres-js `unsafe()` (Docker path)
 * or PGlite `query()` (local path). Array parameters work for both
 * backends when used with `= ANY($n)`.
 */
async function sqlQ<T = Record<string, unknown>>(sqlStr: string, params?: unknown[]): Promise<T[]> {
  if (rootClient) {
    // postgres-js unsafe() params type is narrow; cast through any for the unified helper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    return rootClient.unsafe<T[]>(sqlStr, (params ?? []) as any);
  }
  if (pglite) {
    const r = await pglite.query<T>(sqlStr, params);
    return r.rows;
  }
  throw new Error('no database client initialised');
}

/* ================================================================= */
/*  Seed / truncate helpers                                            */
/* ================================================================= */

async function truncateAll(client: Sql): Promise<void> {
  // audit_log triggers forbid DELETE, so we need DISABLE TRIGGER
  // on it before TRUNCATE ... CASCADE. Using RESTART IDENTITY so
  // bigserial ids are stable across test runs.
  await client.unsafe(`
        ALTER TABLE "audit_log" DISABLE TRIGGER audit_log_forbid_delete;
        TRUNCATE TABLE
            "export_jobs",
            "push_tokens",
            "idempotency_keys",
            "outbox",
            "audit_log",
            "workout_sessions",
            "reservations",
            "classes",
            "users",
            "studios"
        RESTART IDENTITY CASCADE;
        ALTER TABLE "audit_log" ENABLE TRIGGER audit_log_forbid_delete;
    `);
}

/**
 * Full scenario seed: two studios, Alice + Bob, three alpha classes
 * + one bravo class, every FK-joined table populated for both users
 * including 5 audit_log rows each. The seed runs under the superuser
 * client and therefore bypasses RLS.
 */
async function seedScenario(client: Sql): Promise<{
  aliceAuditIds: string[];
  bobAuditIds: string[];
}> {
  const consents = JSON.stringify(DEFAULT_CONSENTS);

  // Studios
  await client`
        INSERT INTO "studios" (id, slug, name, brand_color) VALUES
            (${STUDIO_ALPHA_ID}, 'alpha', 'Studio Alpha', '#0EA5E9'),
            (${STUDIO_BRAVO_ID}, 'bravo', 'Studio Bravo', '#F97316')
    `;

  // Users
  await client`
        INSERT INTO "users" (id, studio_id, email, display_name, role, consents) VALUES
            (${ALICE_ID}, ${STUDIO_ALPHA_ID}, 'alice@athlya.test', 'Alice',  'member', ${consents}::jsonb),
            (${BOB_ID},   ${STUDIO_BRAVO_ID}, 'bob@athlya.test',   'Bob',    'member', ${consents}::jsonb)
    `;

  // Alpha classes
  await client`
        INSERT INTO "classes"
            (id, studio_id, title, starts_at, duration_min, capacity, version)
        VALUES
            (${CLASS_A1}, ${STUDIO_ALPHA_ID}, 'Yoga Flow',   '2026-03-01T09:00:00Z', 60, 20, 0),
            (${CLASS_A2}, ${STUDIO_ALPHA_ID}, 'HIIT',        '2026-03-01T18:00:00Z', 45, 15, 0),
            (${CLASS_A3}, ${STUDIO_ALPHA_ID}, 'Pilates',     '2026-03-02T09:00:00Z', 60, 18, 0),
            (${CLASS_B1}, ${STUDIO_BRAVO_ID}, 'Muay Thai',   '2026-03-01T19:00:00Z', 60, 12, 0)
    `;

  // Reservations — Alice has 3 distinct classes covering all the
  // non-terminal status values a member can hold. Bob has 1.
  await client`
        INSERT INTO "reservations" (class_id, user_id, status) VALUES
            (${CLASS_A1}, ${ALICE_ID}, 'confirmed'),
            (${CLASS_A2}, ${ALICE_ID}, 'waitlist'),
            (${CLASS_A3}, ${ALICE_ID}, 'cancelled'),
            (${CLASS_B1}, ${BOB_ID},   'confirmed')
    `;

  // Workout sessions
  const emptyExercises = JSON.stringify([]);
  await client`
        INSERT INTO "workout_sessions"
            (user_id, studio_id, started_at, duration_min, exercises)
        VALUES
            (${ALICE_ID}, ${STUDIO_ALPHA_ID}, '2026-01-15T08:00:00Z', 60, ${emptyExercises}::jsonb),
            (${ALICE_ID}, ${STUDIO_ALPHA_ID}, '2026-01-20T08:00:00Z', 45, ${emptyExercises}::jsonb),
            (${BOB_ID},   ${STUDIO_BRAVO_ID}, '2026-01-18T08:00:00Z', 60, ${emptyExercises}::jsonb)
    `;

  // Push tokens — 4 for Alice spanning all platforms + a duplicate
  // iOS device so the count isn't trivially degenerate. 1 for Bob.
  await client`
        INSERT INTO "push_tokens" (user_id, platform, token) VALUES
            (${ALICE_ID}, 'ios',     'ExpoPushToken[alice-ios-1]'),
            (${ALICE_ID}, 'ios',     'ExpoPushToken[alice-ios-2]'),
            (${ALICE_ID}, 'android', 'ExpoPushToken[alice-android-1]'),
            (${ALICE_ID}, 'web',     'ExpoPushToken[alice-web-1]'),
            (${BOB_ID},   'ios',     'ExpoPushToken[bob-ios-1]')
    `;

  // Audit log — 5 rows per user. Each alice row carries PII-shaped
  // fields (`email`, `displayName`, `ip`, `userAgent`) plus one
  // non-PII key (`classId`) that MUST survive anonymisation to
  // demonstrate the jsonb "- key" operator targets only PII.
  // Pass plain objects (not JSON.stringify'd strings) so postgres-js serialises
  // them correctly for the ::jsonb cast — pre-stringified values get
  // double-encoded, yielding jsonb_typeof = 'string' instead of 'object'.
  const aliceMeta: Array<Record<string, string>> = [
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.7',
      userAgent: 'AthlyaMobile/1.2 (iPhone 15; iOS 17)',
      classId: CLASS_A1,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.7',
      userAgent: 'AthlyaMobile/1.2 (iPhone 15; iOS 17)',
      classId: CLASS_A2,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.8',
      userAgent: 'AthlyaWeb/1.0 (Firefox 120; macOS)',
      classId: CLASS_A3,
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.9',
      userAgent: 'AthlyaWeb/1.0 (Chrome 120; Windows)',
    },
    {
      email: 'alice@athlya.test',
      displayName: 'Alice',
      ip: '203.0.113.9',
      userAgent: 'AthlyaWeb/1.0 (Chrome 120; Windows)',
    },
  ];
  const bobMeta: Array<Record<string, string>> = [
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.4',
      userAgent: 'AthlyaMobile/1.2 (Pixel 8; Android 14)',
      classId: CLASS_B1,
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.4',
      userAgent: 'AthlyaMobile/1.2 (Pixel 8; Android 14)',
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.5',
      userAgent: 'AthlyaWeb/1.0 (Safari 17; iPadOS)',
    },
    {
      email: 'bob@athlya.test',
      displayName: 'Bob',
      ip: '198.51.100.5',
      userAgent: 'AthlyaWeb/1.0 (Safari 17; iPadOS)',
    },
    { email: 'bob@athlya.test', displayName: 'Bob', ip: '198.51.100.6', userAgent: 'curl/8.5.0' },
  ];

  const aliceAuditRows = await client<{ id: string }[]>`
        INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata) VALUES
            (${ALICE_ID}, 'user.login',             'user',        ${ALICE_ID}, ${client.json(aliceMeta[0]!)}),
            (${ALICE_ID}, 'reservation.created',    'reservation', ${CLASS_A1}, ${client.json(aliceMeta[1]!)}),
            (${ALICE_ID}, 'reservation.cancelled',  'reservation', ${CLASS_A3}, ${client.json(aliceMeta[2]!)}),
            (${ALICE_ID}, 'user.consents.updated',  'user',        ${ALICE_ID}, ${client.json(aliceMeta[3]!)}),
            (${ALICE_ID}, 'user.profile.updated',   'user',        ${ALICE_ID}, ${client.json(aliceMeta[4]!)})
        RETURNING id::text
    `;
  const bobAuditRows = await client<{ id: string }[]>`
        INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata) VALUES
            (${BOB_ID}, 'user.login',             'user',        ${BOB_ID}, ${client.json(bobMeta[0]!)}),
            (${BOB_ID}, 'reservation.created',    'reservation', ${CLASS_B1}, ${client.json(bobMeta[1]!)}),
            (${BOB_ID}, 'user.consents.updated',  'user',        ${BOB_ID}, ${client.json(bobMeta[2]!)}),
            (${BOB_ID}, 'user.profile.updated',   'user',        ${BOB_ID}, ${client.json(bobMeta[3]!)}),
            (${BOB_ID}, 'user.login',             'user',        ${BOB_ID}, ${client.json(bobMeta[4]!)})
        RETURNING id::text
    `;

  return {
    aliceAuditIds: aliceAuditRows.map((r) => r.id),
    bobAuditIds: bobAuditRows.map((r) => r.id),
  };
}

/* ================================================================= */
/*  Vitest lifecycle                                                   */
/* ================================================================= */

beforeAll(async () => {
  if (!dockerReady) {
    // PGlite fallback (CN.9.3): real PostgreSQL WASM. Supports
    // SECURITY DEFINER, PL/pgSQL triggers, and all migrations.
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const pg = new PGlite({ extensions: { pgcrypto, citext } });

    await pg.exec(readMigration('0000_init.sql'));
    await pg.exec(readMigration('0001_rls.sql'));
    await pg.exec(readMigration('0002_export_jobs.sql'));
    await pg.exec(readMigration('0003_audit_anonymization.sql'));
    await pg.exec(readMigration('0004_rls_hardening.sql'));
    await pg.exec(readMigration('0005_password_reset_audit_anonymize.sql'));
    await pg.exec(readMigration('0006_anonymize_audit_scalar_guard.sql'));

    pglite = pg;
    return;
  }

  // Dynamic import so the `@testcontainers/postgresql` module is
  // only resolved when Docker is actually available.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  const started = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('athlya_cascade_test')
    .withUsername(ROOT_ROLE)
    .withPassword('root_test')
    .start();

  container = {
    stop: async () => {
      await started.stop();
    },
  };

  rootClient = postgres(started.getConnectionUri(), {
    max: 4,
    prepare: false,
  });

  // Apply all migrations so the test exercises the production function
  // `anonymize_user_audit(uuid)` from 0003 (SECURITY DEFINER, runs as
  // `athlya_owner` which satisfies the trigger's `current_user` check).
  // 0006 adds the scalar guard needed to tolerate non-object metadata rows.
  await applyMigration(rootClient, readMigration('0000_init.sql'));
  await applyMigration(rootClient, readMigration('0001_rls.sql'));
  await applyMigration(rootClient, readMigration('0002_export_jobs.sql'));
  await applyMigration(rootClient, readMigration('0003_audit_anonymization.sql'));
  await applyMigration(rootClient, readMigration('0004_rls_hardening.sql'));
  await applyMigration(rootClient, readMigration('0005_password_reset_audit_anonymize.sql'));
  await applyMigration(rootClient, readMigration('0006_anonymize_audit_scalar_guard.sql'));
}, 180_000);

afterAll(async () => {
  try {
    await rootClient?.end({ timeout: 5 });
    await pglite?.close();
  } finally {
    await container?.stop();
  }
});

/* ================================================================= */
/*  Property 4 — RGPD cascade (full deletion)                          */
/* ================================================================= */

describe('handleUserDeleted + anonymizeAuditLog — Property 4 (RGPD cascade)', () => {
  it(
    'cascade-deletes every FK-joined row, schedules the 30-day anonymisation job, ' +
      'leaves other users untouched, and anonymises audit rows idempotently at J+30',
    async () => {
      if (!rootClient && !pglite) {
        throw new Error('rootClient not initialised');
      }
      const truncateFn = rootClient
        ? () => truncateAll(rootClient!)
        : () => truncateAllPglite(pglite!);
      const seedFn = rootClient
        ? () => seedScenario(rootClient!)
        : () => seedScenarioPglite(pglite!);
      const repo = rootClient ? buildRepo(rootClient) : buildRepoPglite(pglite!);

      // Arrange — clean slate + seed Alice & Bob's rows.
      await truncateFn();
      const { aliceAuditIds, bobAuditIds } = await seedFn();
      const { avatars, store: avatarStore } = buildAvatars({
        [ALICE_ID]: new Uint8Array([0xff, 0xd8, 0xff]),
        [BOB_ID]: new Uint8Array([0xff, 0xd8, 0xff]),
      });
      const { scheduler, jobs } = buildScheduler();

      // Act — run the cascade at TIME_0.
      const result = await handleUserDeleted(buildEvent(ALICE_ID), {
        repo,
        avatars,
        scheduler,
        clock: buildClock(TIME_0_MS),
      });

      /* --- Result contract --------------------------------- */
      expect(result.kind).toBe('ok');
      expect(result.counts).toEqual({
        reservations: 3,
        sessions: 2,
        pushTokens: 4,
        idempotencyKeys: 0,
        // Anonymisation happens 30 days later — audit rows
        // are NOT touched during the cascade step itself.
        auditAnonymized: 0,
      });
      const expectedDueAt = new Date(TIME_0_MS + THIRTY_DAYS_MS).toISOString();
      expect(result.scheduledAnonymizationAt).toBe(expectedDueAt);

      /* --- SQL-side: Alice is gone ------------------------- */
      const aliceReservations = await sqlQ<{ id: string }>(
        `SELECT id FROM reservations WHERE user_id = $1`,
        [ALICE_ID],
      );
      const aliceSessions = await sqlQ<{ id: string }>(
        `SELECT id FROM workout_sessions WHERE user_id = $1`,
        [ALICE_ID],
      );
      const alicePushTokens = await sqlQ<{ id: string }>(
        `SELECT id FROM push_tokens WHERE user_id = $1`,
        [ALICE_ID],
      );
      expect(aliceReservations).toHaveLength(0);
      expect(aliceSessions).toHaveLength(0);
      expect(alicePushTokens).toHaveLength(0);

      /* --- users tombstone was stamped --------------------- */
      const aliceRow = await sqlQ<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [ALICE_ID],
      );
      expect(aliceRow).toHaveLength(1);
      expect(aliceRow[0]!.deleted_at).toBeInstanceOf(Date);
      expect(aliceRow[0]!.deleted_at!.toISOString()).toBe(new Date(TIME_0_MS).toISOString());

      /* --- Avatar was purged from the R2 fake -------------- */
      expect(avatarStore.has(ALICE_ID)).toBe(false);
      // Bob's avatar is untouched.
      expect(avatarStore.has(BOB_ID)).toBe(true);

      /* --- Scheduler recorded exactly one job -------------- */
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.userId).toBe(ALICE_ID);
      expect(jobs[0]!.dueAt.toISOString()).toBe(expectedDueAt);

      /* --- Audit rows still exist, not yet anonymised ------ */
      const aliceAuditBefore = await sqlQ<{
        actor_id: string | null;
        metadata: Record<string, unknown>;
      }>(`SELECT actor_id::text, metadata FROM audit_log WHERE id::text = ANY($1) ORDER BY id`, [
        aliceAuditIds,
      ]);
      expect(aliceAuditBefore).toHaveLength(aliceAuditIds.length);
      for (const row of aliceAuditBefore) {
        expect(row.actor_id).toBe(ALICE_ID);
        const metadata =
          typeof row.metadata === 'string'
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : row.metadata;
        expect(metadata).toHaveProperty('email');
      }

      /* --- Bob is UNTOUCHED across every table ------------- */
      const bobReservations = await sqlQ<{ id: string }>(
        `SELECT id FROM reservations WHERE user_id = $1`,
        [BOB_ID],
      );
      const bobSessions = await sqlQ<{ id: string }>(
        `SELECT id FROM workout_sessions WHERE user_id = $1`,
        [BOB_ID],
      );
      const bobPushTokens = await sqlQ<{ id: string }>(
        `SELECT id FROM push_tokens WHERE user_id = $1`,
        [BOB_ID],
      );
      const bobRow = await sqlQ<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [BOB_ID],
      );
      expect(bobReservations).toHaveLength(1);
      expect(bobSessions).toHaveLength(1);
      expect(bobPushTokens).toHaveLength(1);
      expect(bobRow[0]!.deleted_at).toBeNull();

      /* ============================================== */
      /*  J + 30 days — QStash fires the anonymisation   */
      /* ============================================== */

      // Simulate the 30-day wait: we don't need to advance
      // any wall-clock since `anonymizeAuditLog` does not
      // read the clock — it just runs the SQL UPDATE.
      const firstAnon = await anonymizeAuditLog(ALICE_ID, {
        repo,
      });
      expect(firstAnon.kind).toBe('ok');
      expect(firstAnon.userId).toBe(ALICE_ID);
      // Should anonymise exactly the 5 audit rows we seeded
      // for Alice.
      expect(firstAnon.anonymizedRows).toBe(aliceAuditIds.length);

      const aliceAuditAfter = await sqlQ<{
        actor_id: string | null;
        metadata: Record<string, unknown>;
      }>(`SELECT actor_id::text, metadata FROM audit_log WHERE id::text = ANY($1) ORDER BY id`, [
        aliceAuditIds,
      ]);
      expect(aliceAuditAfter).toHaveLength(aliceAuditIds.length);
      for (const row of aliceAuditAfter) {
        // Req 5.3: actor_id scrubbed to NULL.
        expect(row.actor_id).toBeNull();
        // PII keys stripped…
        const metaAfter =
          typeof row.metadata === 'string'
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : row.metadata;
        expect(metaAfter).not.toHaveProperty('email');
        expect(metaAfter).not.toHaveProperty('displayName');
        expect(metaAfter).not.toHaveProperty('ip');
        expect(metaAfter).not.toHaveProperty('userAgent');
      }
      // …and non-PII keys survive on the rows that carried
      // them. aliceAuditAfter is ordered by id, mirroring
      // the INSERT order, so rows 0,1,2 retain `classId`.
      const parseMeta = (v: Record<string, unknown>): Record<string, unknown> =>
        typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : v;
      expect(parseMeta(aliceAuditAfter[0]!.metadata)).toHaveProperty('classId');
      expect(parseMeta(aliceAuditAfter[1]!.metadata)).toHaveProperty('classId');
      expect(parseMeta(aliceAuditAfter[2]!.metadata)).toHaveProperty('classId');

      /* --- Bob's audit rows are STILL intact --------------- */
      const bobAuditAfter = await sqlQ<{
        actor_id: string | null;
        metadata: Record<string, unknown>;
      }>(`SELECT actor_id::text, metadata FROM audit_log WHERE id::text = ANY($1) ORDER BY id`, [
        bobAuditIds,
      ]);
      expect(bobAuditAfter).toHaveLength(bobAuditIds.length);
      for (const row of bobAuditAfter) {
        expect(row.actor_id).toBe(BOB_ID);
        const metaBob =
          typeof row.metadata === 'string'
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : row.metadata;
        expect(metaBob).toHaveProperty('email');
        expect(metaBob).toHaveProperty('displayName');
      }

      /* --- Idempotency: 2nd call returns 0 ---------------- */
      const secondAnon = await anonymizeAuditLog(ALICE_ID, {
        repo,
      });
      expect(secondAnon.anonymizedRows).toBe(0);

      /* --- Audit trigger is ACTIVE again -----------------
       * Sanity check: the immutability invariant (Req 22.2)
       * is restored after the anonymisation path returns.
       * Attempting a plain UPDATE against audit_log must
       * raise "audit_log is append-only".
       */
      const triggerErr = await (
        rootClient
          ? rootClient.unsafe(
              `UPDATE audit_log SET metadata = metadata || '{"tampered": true}'::jsonb WHERE id::text = $1`,
              [bobAuditIds[0]!],
            )
          : pglite!.query(
              `UPDATE audit_log SET metadata = metadata || '{"tampered": true}'::jsonb WHERE id::text = $1`,
              [bobAuditIds[0]!],
            )
      ).catch((e: unknown) => e);
      expect(triggerErr).toBeInstanceOf(Error);
      expect((triggerErr as Error).message).toMatch(/append-only/i);
    },
    180_000,
  );

  it(
    'scheduler failure rethrows so the event bus redrives — ' +
      'but the SQL cascade has already completed (idempotent retry)',
    async () => {
      if (!rootClient && !pglite) {
        throw new Error('rootClient not initialised');
      }
      const truncateFn = rootClient
        ? () => truncateAll(rootClient!)
        : () => truncateAllPglite(pglite!);
      const repo = rootClient ? buildRepo(rootClient) : buildRepoPglite(pglite!);

      await truncateFn();
      await (rootClient ? seedScenario(rootClient) : seedScenarioPglite(pglite!));
      const { avatars, store: avatarStore } = buildAvatars({
        [ALICE_ID]: new Uint8Array([0xff, 0xd8, 0xff]),
      });
      // Scheduler ALWAYS fails — this is the failure mode
      // the `cascade.ts` JSDoc calls out as "rethrows so
      // the event bus redrives".
      const scheduler: Scheduler = {
        scheduleAnonymization() {
          return Promise.reject(new Error('QStash unreachable'));
        },
      };

      const err = await handleUserDeleted(buildEvent(ALICE_ID), {
        repo,
        avatars,
        scheduler,
        clock: buildClock(TIME_0_MS),
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('QStash unreachable');

      // SQL cascade completed BEFORE the scheduler call —
      // this is the invariant the redelivery contract rests
      // on (re-running the cascade finds 0 rows to delete
      // and is a no-op for the downstream tables).
      const aliceReservations = await sqlQ<{ id: string }>(
        `SELECT id FROM reservations WHERE user_id = $1`,
        [ALICE_ID],
      );
      const aliceSessions = await sqlQ<{ id: string }>(
        `SELECT id FROM workout_sessions WHERE user_id = $1`,
        [ALICE_ID],
      );
      const alicePushTokens = await sqlQ<{ id: string }>(
        `SELECT id FROM push_tokens WHERE user_id = $1`,
        [ALICE_ID],
      );
      const aliceRow = await sqlQ<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [ALICE_ID],
      );
      expect(aliceReservations).toHaveLength(0);
      expect(aliceSessions).toHaveLength(0);
      expect(alicePushTokens).toHaveLength(0);
      expect(aliceRow[0]!.deleted_at).toBeInstanceOf(Date);

      // Avatar is purged too — it sits BEFORE the scheduler
      // call in the documented cascade order.
      expect(avatarStore.has(ALICE_ID)).toBe(false);
    },
    180_000,
  );
});

/* ================================================================= */
/*  Always-registered infra probe                                      */
/*                                                                    */
/*  Ensures the test file itself loads cleanly even on machines        */
/*  without Docker — a broken import or typo would surface here        */
/*  rather than silently being hidden behind a skipped describe.       */
/* ================================================================= */

describe('cascade integration suite registration', () => {
  it('imports the cascade module and exposes handleUserDeleted / anonymizeAuditLog', () => {
    expect(typeof handleUserDeleted).toBe('function');
    expect(typeof anonymizeAuditLog).toBe('function');
  });

  it.skipIf(dockerReady)('logs a clear message when Docker is unavailable', () => {
    // A green record of the skip; CI dashboards that filter
    // by "skipped" will surface this on machines where the
    // RGPD cascade integration is not exercised.
    expect(dockerReady).toBe(false);
  });
});
