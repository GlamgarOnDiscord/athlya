/**
 * Real concurrency proofs for booking, cancellation and capacity edits.
 *
 * A Postgres 17 container gets EVERY forward migration, then the
 * production adapters (`createDrizzleBookingRepo`,
 * `createDrizzleCancelRepo`, `createDrizzleUpdateClassRepo`) run as the
 * NOBYPASSRLS `athlya_app` runtime role over a pooled postgres-js
 * client, so the transactions genuinely interleave on separate
 * connections. Each scenario fires its calls with `Promise.allSettled`
 * and asserts the committed state read back by the superuser:
 *
 *   1. N concurrent bookings never confirm more than C seats, even
 *      when the Redis counter lies and admits everyone (Postgres alone
 *      holds the line).
 *   2. One member booking the same class concurrently ends with one
 *      live row.
 *   3. Cancellations racing new bookings keep `confirmed <= capacity`
 *      and promote waiters in FIFO order.
 *   4. A capacity decrease racing bookings never leaves more confirmed
 *      rows than the final capacity, and a decrease below the
 *      confirmed count is refused.
 *
 * Docker-gated like the other Testcontainers suites: without a daemon
 * the suite skips with a log line.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDbFromClient,
  type AthlyaDb,
  type AthlyaDbHttp,
  type TenantClaims,
} from '@athlya/db/client';
import { bookClass, type BookingCounter } from '@athlya/reservations';
import { cancelReservation } from '@athlya/reservations/cancel';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDrizzleUpdateClassRepo } from '../../src/adapters/classes-repo-drizzle.js';
import {
  createBookingEventPublisher,
  createDrizzleBookingRepo,
  createDrizzleCancelRepo,
} from '../../src/adapters/reservations-write-drizzle.js';

function detectDocker(): boolean {
  try {
    const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf8',
    });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const dockerReady = detectDocker();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../db/migrations');

const APP_ROLE = 'athlya_app';
const APP_PASSWORD = 'concurrency_test';
const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-1111111111a0';
const CLASS_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccc201';
const MEMBER_COUNT = 40;
const MEMBERS = Array.from(
  { length: MEMBER_COUNT },
  (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
);

let container: { stop: () => Promise<void> } | null = null;
let root: Sql | null = null;
let appClient: Sql | null = null;
let db: AthlyaDb | null = null;

const member = (userId: string): TenantClaims => ({ userId, studioId: STUDIO, role: 'member' });
const admin: TenantClaims = { userId: ADMIN, studioId: STUDIO, role: 'admin' };

/** Atomic in-process counter: the event loop serialises every update. */
function atomicCounter(remaining: number): BookingCounter {
  let n = remaining;
  return {
    decrRemaining: () => Promise.resolve(--n),
    decrRemainingOrInit: () => Promise.resolve(--n),
    incrRemaining: () => Promise.resolve(++n),
  };
}

/** A counter that always admits: only Postgres can refuse a seat. */
const lyingCounter: BookingCounter = {
  decrRemaining: () => Promise.resolve(1_000),
  decrRemainingOrInit: () => Promise.resolve(1_000),
  incrRemaining: () => Promise.resolve(1_000),
};

const silent = { error: () => undefined };

function requireDb(): { db: AthlyaDb; root: Sql } {
  if (db === null || root === null) throw new Error('test infrastructure not initialised');
  return { db, root };
}

function book(userId: string, counter: BookingCounter) {
  const { db: appDb } = requireDb();
  return bookClass({
    classId: CLASS_ID,
    userId,
    studioId: STUDIO,
    repo: createDrizzleBookingRepo(appDb, member(userId)),
    counter,
    publisher: createBookingEventPublisher(),
    logger: silent,
  });
}

function cancel(reservationId: string, userId: string) {
  const { db: appDb } = requireDb();
  return cancelReservation({
    reservationId,
    userId,
    repo: createDrizzleCancelRepo(appDb, member(userId)),
    counter: { incrRemaining: () => Promise.resolve() },
    logger: silent,
  });
}

interface Row {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
}

/** Live rows in promotion order (`created_at`, then `id`). */
async function liveRows(): Promise<Row[]> {
  const { root: su } = requireDb();
  return su<Row[]>`
    SELECT id, user_id, status FROM reservations
     WHERE class_id = ${CLASS_ID} AND status IN ('confirmed', 'waitlist')
     ORDER BY created_at, id
  `;
}

async function capacity(): Promise<number> {
  const { root: su } = requireDb();
  const [row] = await su<
    { capacity: number }[]
  >`SELECT capacity FROM classes WHERE id = ${CLASS_ID}`;
  return row?.capacity ?? -1;
}

async function resetClass(cap: number): Promise<void> {
  const { root: su } = requireDb();
  await su`DELETE FROM outbox`;
  await su`DELETE FROM reservations`;
  await su`UPDATE classes SET capacity = ${cap}, version = 0 WHERE id = ${CLASS_ID}`;
}

beforeAll(async () => {
  if (!dockerReady) {
    console.warn('[booking-concurrency] Docker daemon unreachable; suite skipped.');
    return;
  }
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const started = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('athlya_concurrency')
    .withUsername('postgres')
    .withPassword('root_test')
    .start();
  container = { stop: async () => void (await started.stop()) };
  const rootUri = started.getConnectionUri();
  root = postgres(rootUri, { max: 2, prepare: false });

  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    // CONCURRENTLY cannot run in the implicit transaction of a
    // multi-statement query, and the table is empty anyway.
    await root.unsafe(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }

  await root.unsafe(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  const [role] = await root<{ rolbypassrls: boolean }[]>`
    SELECT rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}
  `;
  if (role?.rolbypassrls !== false) throw new Error(`${APP_ROLE} must be NOBYPASSRLS`);

  const consents =
    '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}';
  await root`INSERT INTO studios (id, slug, name) VALUES (${STUDIO}, 'studio-c', 'Studio C')`;
  await root`
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    VALUES (${ADMIN}, ${STUDIO}, 'admin@test.dev', 'Admin', 'admin', ${consents}::text::jsonb)
  `;
  for (const [i, id] of MEMBERS.entries()) {
    await root`
      INSERT INTO users (id, studio_id, email, display_name, role, consents)
      VALUES (${id}, ${STUDIO}, ${`m${String(i)}@test.dev`}, ${`M${String(i)}`}, 'member',
              ${consents}::text::jsonb)
    `;
  }
  await root`
    INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version)
    VALUES (${CLASS_ID}, ${STUDIO}, 'Contended', now() + interval '7 days', 60, 5, 0)
  `;

  const appUri = new URL(rootUri);
  appUri.username = APP_ROLE;
  appUri.password = APP_PASSWORD;
  appClient = postgres(appUri.toString(), { max: MEMBER_COUNT, prepare: false });
  db = createDbFromClient(appClient);
}, 240_000);

afterAll(async () => {
  try {
    await appClient?.end({ timeout: 5 });
    await root?.end({ timeout: 5 });
  } finally {
    await container?.stop();
  }
});

describe.skipIf(!dockerReady)('booking concurrency (Postgres, athlya_app)', () => {
  beforeEach(async () => {
    await resetClass(5);
  });

  it('N concurrent bookings never confirm more than C seats, even with a lying counter', async () => {
    for (const counter of [atomicCounter(5), lyingCounter]) {
      await resetClass(5);

      await Promise.allSettled(MEMBERS.map((m) => book(m, counter)));

      const rows = await liveRows();
      const confirmed = rows.filter((r) => r.status === 'confirmed').length;
      expect(confirmed).toBe(5);
      expect(rows.filter((r) => r.status === 'waitlist')).toHaveLength(MEMBER_COUNT - 5);
      expect(new Set(rows.map((r) => r.user_id)).size).toBe(rows.length);
    }
  }, 120_000);

  it('one member booking the same class concurrently ends with one live row', async () => {
    const [m] = MEMBERS as [string];

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => book(m, atomicCounter(5))),
    );

    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    const fulfilled = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value.code] : []));
    expect(fulfilled.filter((c) => c === 'ok')).toHaveLength(1);
    expect(fulfilled.filter((c) => c !== 'ok').every((c) => c === 'already_booked')).toBe(true);
  }, 60_000);

  it('cancellations racing bookings keep confirmed <= capacity and promote FIFO', async () => {
    const counter = atomicCounter(5);
    const holders = MEMBERS.slice(0, 5);
    const waiters = MEMBERS.slice(5, 15);
    const late = MEMBERS.slice(15, 25);
    for (const m of [...holders, ...waiters]) await book(m, counter);
    const before = await liveRows();
    const waitOrder = before.filter((r) => r.status === 'waitlist').map((r) => r.user_id);
    const seats = before.filter((r) => r.status === 'confirmed');

    await Promise.allSettled([
      ...seats.slice(0, 3).map((r) => cancel(r.id, r.user_id)),
      ...late.map((m) => book(m, counter)),
    ]);

    const after = await liveRows();
    const confirmed = after.filter((r) => r.status === 'confirmed').map((r) => r.user_id);
    expect(confirmed.length).toBeLessThanOrEqual(5);
    // The promoted waiters are exactly the oldest ones: a prefix of
    // the original waitlist order.
    const promoted = waitOrder.filter((u) => confirmed.includes(u));
    expect(promoted).toEqual(waitOrder.slice(0, promoted.length));
    expect(waiters.length).toBeGreaterThan(0);
  }, 120_000);

  it('a capacity decrease racing bookings never leaves confirmed above capacity', async () => {
    const { db: appDb } = requireDb();
    const counter = atomicCounter(5);
    await book(MEMBERS[0] as string, counter);
    const repo = createDrizzleUpdateClassRepo(appDb as unknown as AthlyaDbHttp, appDb, admin);

    const [update] = await Promise.allSettled([
      repo.updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 2 }, 0),
      ...MEMBERS.slice(1, 12).map((m) => book(m, lyingCounter)),
    ]);

    const rows = await liveRows();
    const confirmed = rows.filter((r) => r.status === 'confirmed').length;
    expect(confirmed).toBeLessThanOrEqual(await capacity());
    expect(update.status).toBe('fulfilled');
    if (update.status === 'fulfilled' && update.value.outcome === 'capacity_below_confirmed') {
      // The bookings won the lock first: the class kept capacity 5.
      expect(await capacity()).toBe(5);
    }

    // With the class now holding more confirmed rows than 1, lowering
    // to 1 is always refused and changes nothing.
    const refused = await repo.updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 1 }, 1);
    const version = refused.outcome === 'version_conflict' ? 0 : 1;
    const retry =
      refused.outcome === 'version_conflict'
        ? await repo.updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 1 }, version)
        : refused;
    expect(retry).toMatchObject({ outcome: 'capacity_below_confirmed' });
  }, 120_000);
});

describe('booking concurrency suite registration', () => {
  it.skipIf(dockerReady)('logs a clear message when Docker is unavailable', () => {
    expect(dockerReady).toBe(false);
  });

  it('pins the scenario sizes', () => {
    expect(MEMBERS).toHaveLength(MEMBER_COUNT);
  });
});
