/**
 * Booking, cancellation and capacity edits through the production
 * adapters, against the full migration chain, run as the `athlya_app`
 * runtime role (NOBYPASSRLS).
 *
 * PGlite is single-connection, so this suite pins the SQL and the
 * policies the adapters rely on; the real concurrency proofs live in
 * `tests/integration/booking-concurrency.docker.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@athlya/db/schema';
import { bookClass, type BookingCounter } from '@athlya/reservations';
import { cancelReservation } from '@athlya/reservations/cancel';
import { confirmHold, placeHold } from '@athlya/reservations/hold';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDrizzleUpdateClassRepo } from '../../adapters/classes-repo-drizzle.js';
import {
  createBookingEventPublisher,
  createDrizzleBookingRepo,
  createDrizzleCancelRepo,
} from '../../adapters/reservations-write-drizzle.js';

import type { AthlyaDb, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-1111111111a0';
const MEMBERS = [1, 2, 3, 4, 5].map((n) => `11111111-1111-4111-8111-11111111111${String(n)}`);
const CLASS_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccc101';
const PAST_CLASS_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccc102';

let pglite: PGlite;
let db: AthlyaDb;

const member = (userId: string): TenantClaims => ({ userId, studioId: STUDIO, role: 'member' });
const admin: TenantClaims = { userId: ADMIN, studioId: STUDIO, role: 'admin' };

/** Single-threaded stand-in for the Redis counter. */
function memoryCounter(remaining: number): BookingCounter & { value: () => number } {
  let n = remaining;
  return {
    decrRemaining: () => Promise.resolve(--n),
    decrRemainingOrInit: () => Promise.resolve(--n),
    incrRemaining: () => Promise.resolve(++n),
    value: () => n,
  };
}

async function asOwner(query: string): Promise<void> {
  await pglite.exec('RESET ROLE');
  try {
    await pglite.exec(query);
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

async function book(userId: string, counter: BookingCounter, classId = CLASS_ID) {
  return bookClass({
    classId,
    userId,
    studioId: STUDIO,
    repo: createDrizzleBookingRepo(db, member(userId)),
    counter,
    publisher: createBookingEventPublisher(),
    logger: { error: () => undefined },
  });
}

function hold(userId: string, counter: BookingCounter, classVersion?: number) {
  return placeHold({
    classId: CLASS_ID,
    userId,
    studioId: STUDIO,
    ...(classVersion !== undefined ? { classVersion } : {}),
    repo: createDrizzleBookingRepo(db, member(userId)),
    counter,
    logger: { error: () => undefined },
  });
}

function confirm(userId: string, reservationId: string) {
  return confirmHold({
    reservationId,
    userId,
    studioId: STUDIO,
    repo: createDrizzleBookingRepo(db, member(userId)),
    publisher: createBookingEventPublisher(),
  });
}

async function ownerQuery<T>(query: string): Promise<T[]> {
  await pglite.exec('RESET ROLE');
  try {
    return (await pglite.query<T>(query)).rows;
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

async function statuses(): Promise<Record<string, string>> {
  await pglite.exec('RESET ROLE');
  try {
    const res = await pglite.query<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM reservations WHERE class_id = '${CLASS_ID}' AND status <> 'cancelled'`,
    );
    return Object.fromEntries(res.rows.map((r) => [r.user_id, r.status]));
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  const users = [ADMIN, ...MEMBERS]
    .map(
      (id, i) =>
        `('${id}', '${STUDIO}', 'user-${String(i)}@test.dev', 'User ${String(i)}', '${
          id === ADMIN ? 'admin' : 'member'
        }', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb)`,
    )
    .join(',\n');
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES ('${STUDIO}', 'studio-a', 'Studio A');
    INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES ${users};
    INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES
      ('${CLASS_ID}', '${STUDIO}', 'Future', '2099-01-01 09:00:00+00', 60, 2, 0),
      ('${PAST_CLASS_ID}', '${STUDIO}', 'Past', '2020-01-01 09:00:00+00', 60, 5, 0);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

beforeEach(async () => {
  // Recreated rather than updated: `guard_class_schedule()` refuses a
  // capacity change that does not move `version` forward (0050).
  await asOwner(`
    DELETE FROM reservations;
    DELETE FROM classes WHERE id = '${CLASS_ID}';
    INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version)
    VALUES ('${CLASS_ID}', '${STUDIO}', 'Future', '2099-01-01 09:00:00+00', 60, 2, 0);
  `);
});

afterAll(async () => {
  await pglite.close();
});

describe('booking adapters under athlya_app', () => {
  it('replays a confirmed booking with its real status, ignoring an older cancelled row', async () => {
    const [m1] = MEMBERS as [string];
    await asOwner(
      `INSERT INTO reservations (class_id, user_id, status, cancelled_at)
       VALUES ('${CLASS_ID}', '${m1}', 'cancelled', now() - interval '1 day')`,
    );
    const counter = memoryCounter(2);

    const first = await book(m1, counter);
    const replay = await book(m1, counter);

    expect(first.code).toBe('ok');
    expect(replay).toMatchObject({ code: 'already_booked', reservation: { status: 'confirmed' } });
    expect(replay).not.toHaveProperty('position');
    // The replay compensated its DECR: one seat used.
    expect(counter.value()).toBe(1);
  });

  it('replays a waitlist booking as waitlist with its position', async () => {
    const [m1, m2, m3, m4] = MEMBERS as [string, string, string, string];
    const counter = memoryCounter(2);
    await book(m1, counter);
    await book(m2, counter);
    await book(m3, counter);
    const first = await book(m4, counter);

    const replay = await book(m4, counter);

    if (first.code !== 'waitlisted') throw new Error(`unexpected ${first.code}`);
    expect(replay).toMatchObject({
      code: 'already_booked',
      reservation: { id: first.reservation.id, status: 'waitlist' },
      position: first.position,
    });
  });

  it('decides class_in_past with the database clock when no clock is injected', async () => {
    const [m1] = MEMBERS as [string];
    const counter = memoryCounter(5);

    await expect(book(m1, counter, PAST_CLASS_ID)).resolves.toEqual({ code: 'class_in_past' });
    expect(counter.value()).toBe(5);
  });
});

describe('cancel adapter under athlya_app', () => {
  it('answers already_cancelled on a second cancel, promoting the oldest waiter only once', async () => {
    const [m1, m2, m3, m4] = MEMBERS as [string, string, string, string];
    const counter = memoryCounter(2);
    const booked = await book(m1, counter);
    await book(m2, counter);
    await book(m3, counter);
    await book(m4, counter);
    if (booked.code !== 'ok') throw new Error(`unexpected ${booked.code}`);

    const cancel = () =>
      cancelReservation({
        reservationId: booked.reservation.id,
        userId: m1,
        repo: createDrizzleCancelRepo(db, member(m1)),
        counter: { incrRemaining: () => Promise.resolve() },
      });

    const first = await cancel();
    const second = await cancel();

    expect(first).toMatchObject({ code: 'ok', promoted: { userId: m3 } });
    expect(second).toMatchObject({ code: 'already_cancelled', cancelled: { status: 'cancelled' } });
    expect(await statuses()).toEqual({ [m2]: 'confirmed', [m3]: 'confirmed', [m4]: 'waitlist' });
  });
});

describe('class update adapter under athlya_app (admin)', () => {
  const repo = () => createDrizzleUpdateClassRepo(db as unknown as AthlyaDbHttp, db, admin);

  it('refuses a capacity below the confirmed count and writes nothing', async () => {
    const [m1, m2] = MEMBERS as [string, string];
    const counter = memoryCounter(2);
    await book(m1, counter);
    await book(m2, counter);

    const result = await repo().updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 1 }, 0);

    expect(result).toEqual({ outcome: 'capacity_below_confirmed', confirmed: 2 });
    const again = await repo().updateClassOptimistic(STUDIO, CLASS_ID, { title: 'Renamed' }, 0);
    expect(again).toMatchObject({ outcome: 'updated', row: { capacity: 2, version: 1 } });
  });

  it('promotes waiters FIFO into the seats a capacity increase frees', async () => {
    const [m1, m2, m3, m4, m5] = MEMBERS as [string, string, string, string, string];
    const counter = memoryCounter(2);
    for (const m of [m1, m2, m3, m4, m5]) await book(m, counter);

    const result = await repo().updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 4 }, 0);

    expect(result).toMatchObject({ outcome: 'updated', confirmed: 4, row: { capacity: 4 } });
    expect(await statuses()).toEqual({
      [m1]: 'confirmed',
      [m2]: 'confirmed',
      [m3]: 'confirmed',
      [m4]: 'confirmed',
      [m5]: 'waitlist',
    });
  });

  it('answers version_conflict on a stale version', async () => {
    const result = await repo().updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 3 }, 7);
    expect(result).toEqual({ outcome: 'version_conflict' });
  });
});

describe('seat holds through the adapters (issue #723)', () => {
  it('holds a seat that a confirmed booking can then not take', async () => {
    const [m1, m2, m3] = MEMBERS as [string, string, string];
    const counter = memoryCounter(2);

    const held = await hold(m1, counter);
    await book(m2, counter);
    const third = await book(m3, counter);

    expect(held).toMatchObject({ code: 'held', hold: { classId: CLASS_ID } });
    if (held.code !== 'held') throw new Error(`unexpected ${held.code}`);
    expect(held.hold.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(third.code).toBe('waitlisted');
    expect(await statuses()).toEqual({ [m1]: 'pending', [m2]: 'confirmed', [m3]: 'waitlist' });
  });

  it('answers class_full when the class has no seat left for a hold', async () => {
    const [m1, m2, m3] = MEMBERS as [string, string, string];
    const counter = memoryCounter(5);
    await book(m1, counter);
    await hold(m2, counter);

    await expect(hold(m3, counter)).resolves.toEqual({ code: 'class_full' });
    expect(await statuses()).toEqual({ [m1]: 'confirmed', [m2]: 'pending' });
  });

  it('answers already_held on a second hold of the same member', async () => {
    const [m1] = MEMBERS as [string];
    const counter = memoryCounter(5);
    const first = await hold(m1, counter);
    const second = await hold(m1, counter);

    if (first.code !== 'held') throw new Error(`unexpected ${first.code}`);
    expect(second).toEqual({ code: 'already_held', hold: first.hold });
  });

  it('confirms a hold into a confirmed row with one reservation.created event', async () => {
    const [m1, m2] = MEMBERS as [string, string];
    const counter = memoryCounter(2);
    const held = await hold(m1, counter);
    await book(m2, counter);
    if (held.code !== 'held') throw new Error(`unexpected ${held.code}`);

    const confirmed = await confirm(m1, held.hold.reservationId);
    const replay = await confirm(m1, held.hold.reservationId);

    expect(confirmed).toMatchObject({ code: 'confirmed', reservation: { status: 'confirmed' } });
    expect(replay).toMatchObject({ code: 'already_confirmed' });
    // The wire row never carries the hold column.
    if (confirmed.code !== 'confirmed') throw new Error('unexpected');
    expect(Object.keys(confirmed.reservation).sort()).toEqual(
      ['cancelledAt', 'checkedInAt', 'classId', 'createdAt', 'id', 'status', 'userId'].sort(),
    );
    const events = await ownerQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE event_type = 'reservation.created'
          AND payload->>'reservationId' = '${held.hold.reservationId}'`,
    );
    expect(events[0]?.n).toBe(1);
  });

  it('refuses to confirm an expired hold, and a booking replaces it', async () => {
    const [m1] = MEMBERS as [string];
    await asOwner(`
      SET session_replication_role = replica;
      INSERT INTO reservations (id, class_id, user_id, status, hold_expires_at)
      VALUES ('dddddddd-dddd-4ddd-8ddd-ddddddd72301', '${CLASS_ID}', '${m1}', 'pending', now() - interval '1 minute');
      SET session_replication_role = origin;
    `);

    await expect(confirm(m1, 'dddddddd-dddd-4ddd-8ddd-ddddddd72301')).resolves.toEqual({
      code: 'hold_expired',
    });
    const booked = await book(m1, memoryCounter(2));

    expect(booked.code).toBe('ok');
    const rows = await ownerQuery<{ status: string }>(
      `SELECT status FROM reservations WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddd72301'`,
    );
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('turns a booking on top of an active own hold into its confirmation', async () => {
    const [m1] = MEMBERS as [string];
    const counter = memoryCounter(2);
    const held = await hold(m1, counter);
    if (held.code !== 'held') throw new Error(`unexpected ${held.code}`);

    const booked = await book(m1, counter);

    expect(booked).toMatchObject({
      code: 'ok',
      reservation: { id: held.hold.reservationId, status: 'confirmed' },
    });
  });

  it('releases an active hold on cancel and promotes the oldest waiter', async () => {
    const [m1, m2, m3] = MEMBERS as [string, string, string];
    const counter = memoryCounter(2);
    const held = await hold(m1, counter);
    await book(m2, counter);
    await book(m3, counter);
    if (held.code !== 'held') throw new Error(`unexpected ${held.code}`);

    const released = await cancelReservation({
      reservationId: held.hold.reservationId,
      userId: m1,
      repo: createDrizzleCancelRepo(db, member(m1)),
      counter: { incrRemaining: () => Promise.resolve() },
    });

    expect(released).toMatchObject({ code: 'ok', promoted: { userId: m3 } });
    expect(await statuses()).toEqual({ [m2]: 'confirmed', [m3]: 'confirmed' });
  });
});

describe('class version fence and schedule guard (issue #723)', () => {
  const repo = () => createDrizzleUpdateClassRepo(db as unknown as AthlyaDbHttp, db, admin);

  it('refuses a booking and a hold that carry a stale classVersion', async () => {
    const [m1, m2] = MEMBERS as [string, string];
    await repo().updateClassOptimistic(STUDIO, CLASS_ID, { title: 'Moved' }, 0);

    const booking = await bookClass({
      classId: CLASS_ID,
      userId: m1,
      studioId: STUDIO,
      classVersion: 0,
      repo: createDrizzleBookingRepo(db, member(m1)),
      counter: memoryCounter(2),
      publisher: createBookingEventPublisher(),
      logger: { error: () => undefined },
    });

    expect(booking).toEqual({ code: 'class_changed' });
    await expect(hold(m2, memoryCounter(2), 0)).resolves.toEqual({ code: 'class_changed' });
    await expect(hold(m2, memoryCounter(2), 1)).resolves.toMatchObject({ code: 'held' });
  });

  it('counts an active hold when capacity is lowered', async () => {
    const [m1, m2] = MEMBERS as [string, string];
    const counter = memoryCounter(2);
    await book(m1, counter);
    await hold(m2, counter);

    await expect(
      repo().updateClassOptimistic(STUDIO, CLASS_ID, { capacity: 1 }, 0),
    ).resolves.toEqual({ outcome: 'capacity_below_confirmed', confirmed: 2 });
  });

  it('refuses to move a class into the past or a class that already started', async () => {
    await expect(
      repo().updateClassOptimistic(STUDIO, CLASS_ID, { startsAt: '2020-01-01T09:00:00.000Z' }, 0),
    ).resolves.toEqual({ outcome: 'starts_at_in_past' });

    const startedRepo = () =>
      createDrizzleUpdateClassRepo(db as unknown as AthlyaDbHttp, db, admin);
    await expect(
      startedRepo().updateClassOptimistic(
        STUDIO,
        PAST_CLASS_ID,
        { startsAt: '2099-06-01T09:00:00.000Z' },
        0,
      ),
    ).resolves.toEqual({ outcome: 'class_already_started' });
  });

  it('refuses, in the database, a capacity change that does not bump version', async () => {
    await expect(
      ownerQuery(`UPDATE classes SET capacity = 9 WHERE id = '${CLASS_ID}'`),
    ).rejects.toThrow(/class_version_not_bumped/u);
  });
});
