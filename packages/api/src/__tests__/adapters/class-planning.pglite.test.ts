/**
 * Rooms, weekly series and conflict lookups (issue #748) against the
 * full migration chain, run as the `athlya_app` role under RLS
 * (`rooms_*`, `classes_*`, `reservations_*`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@athlya/db/schema';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPlacementAsTenant,
  createRoomsRepo,
  createSeriesRepo,
} from '../../adapters/class-planning-drizzle.js';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { CreateClassSeriesRequest } from '@athlya/shared/schemas/api';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STUDIO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = '11111111-1111-4111-8111-1111111111a0';
const COACH = '11111111-1111-4111-8111-1111111111c0';
const MEMBER = '11111111-1111-4111-8111-111111111101';
const ROOM_A = 'a0510000-0000-4000-8000-0000000000a1';
const ROOM_B = 'a0510000-0000-4000-8000-0000000000b1';
const FOREIGN_ROOM = 'a0510000-0000-4000-8000-0000000000f1';
const YOGA = 'c0510000-0000-4000-8000-000000000001';
const PAST = 'c0510000-0000-4000-8000-000000000002';

const admin: TenantClaims = { userId: ADMIN, studioId: STUDIO, role: 'admin' };
const member: TenantClaims = { userId: MEMBER, studioId: STUDIO, role: 'member' };

let pglite: PGlite;
let db: AthlyaDb;

async function asOwner<T = Record<string, unknown>>(query: string): Promise<T[]> {
  await pglite.exec('RESET ROLE');
  try {
    const results = await pglite.exec(query);
    return (results.at(-1)?.rows ?? []) as T[];
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

const slot = (
  startsAt: string,
  durationMin: number,
  roomId: string | null,
  coachId: string | null,
) => ({
  startsAt: new Date(startsAt),
  durationMin,
  roomId,
  coachId,
});

beforeAll(async () => {
  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  const consents =
    '\'{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}\'::jsonb';
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES
      ('${STUDIO}', 'studio-a', 'Studio A'), ('${OTHER_STUDIO}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES
      ('${ADMIN}', '${STUDIO}', 'admin@test.dev', 'Admin', 'admin', ${consents}),
      ('${COACH}', '${STUDIO}', 'coach@test.dev', 'Coach', 'coach', ${consents}),
      ('${MEMBER}', '${STUDIO}', 'member@test.dev', 'Member', 'member', ${consents});
    INSERT INTO rooms (id, studio_id, name) VALUES ('${FOREIGN_ROOM}', '${OTHER_STUDIO}', 'Ring');
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await asOwner(`
    DELETE FROM reservations;
    DELETE FROM classes;
    DELETE FROM rooms WHERE studio_id = '${STUDIO}';
    INSERT INTO rooms (id, studio_id, name, capacity) VALUES
      ('${ROOM_A}', '${STUDIO}', 'Studio 1', 20),
      ('${ROOM_B}', '${STUDIO}', 'Cycling', NULL);
    INSERT INTO classes (id, studio_id, coach_id, room_id, title, starts_at, duration_min, capacity, version) VALUES
      ('${YOGA}', '${STUDIO}', '${COACH}', '${ROOM_A}', 'Yoga', '2099-01-05 09:00:00+00', 60, 10, 0),
      ('${PAST}', '${STUDIO}', NULL, '${ROOM_A}', 'Past', '2020-01-05 09:00:00+00', 60, 10, 0);
  `);
});

describe('rooms', () => {
  it('lists the live rooms of the studio by name, never another studio', async () => {
    const rows = await createRoomsRepo(db, member).list();
    expect(rows.map((r) => r.name)).toEqual(['Cycling', 'Studio 1']);
  });

  it('creates, renames and refuses a taken name regardless of case', async () => {
    const repo = createRoomsRepo(db, admin);
    const created = await repo.create({ name: 'Mat room', capacity: 15 });
    expect(created).toMatchObject({ kind: 'ok', room: { name: 'Mat room', capacity: 15 } });
    expect(await repo.create({ name: 'studio 1' })).toEqual({ kind: 'name_taken' });
    expect(await repo.update(ROOM_B, { name: 'STUDIO 1' })).toEqual({ kind: 'name_taken' });
    expect(await repo.update(ROOM_B, { capacity: 30 })).toMatchObject({
      kind: 'ok',
      room: { capacity: 30 },
    });
    expect(await repo.update(FOREIGN_ROOM, { capacity: 30 })).toEqual({ kind: 'not_found' });
  });

  it('a member cannot create a room (RLS)', async () => {
    await expect(createRoomsRepo(db, member).create({ name: 'Nope' })).rejects.toThrow();
  });

  it('deleting a room unassigns its upcoming classes and keeps the past ones', async () => {
    const repo = createRoomsRepo(db, admin);
    expect(await repo.remove(ROOM_A)).toEqual({ kind: 'deleted' });
    expect(await repo.remove(ROOM_A)).toEqual({ kind: 'not_found' });
    const rows = await asOwner<{ id: string; room_id: string | null; version: number }>(
      `SELECT id, room_id, version FROM classes ORDER BY starts_at`,
    );
    expect(rows).toEqual([
      { id: PAST, room_id: ROOM_A, version: 0 },
      { id: YOGA, room_id: null, version: 1 },
    ]);
    expect((await repo.list()).map((r) => r.id)).toEqual([ROOM_B]);
    expect(await repo.create({ name: 'Studio 1' })).toMatchObject({ kind: 'ok' });
  });
});

describe('conflicts', () => {
  const check = (slots: ReturnType<typeof slot>[], ignore: string[] = []) =>
    checkPlacementAsTenant(db, admin, slots, { allowConflicts: false, ignore });

  it('reports the same room over an overlapping interval', async () => {
    const outcome = await check([slot('2099-01-05T09:30:00Z', 30, ROOM_A, null)]);
    expect(outcome).toEqual({
      kind: 'schedule_conflict',
      conflicts: [
        {
          occurrenceStartsAt: '2099-01-05T09:30:00.000Z',
          classId: YOGA,
          title: 'Yoga',
          startsAt: '2099-01-05T09:00:00.000Z',
          durationMin: 60,
          reasons: ['room'],
        },
      ],
    });
  });

  it('reports the same coach in another room, and both reasons together', async () => {
    const coach = await check([slot('2099-01-05T08:30:00Z', 45, ROOM_B, COACH)]);
    expect(coach).toMatchObject({ kind: 'schedule_conflict', conflicts: [{ reasons: ['coach'] }] });
    const both = await check([slot('2099-01-05T09:00:00Z', 60, ROOM_A, COACH)]);
    expect(both).toMatchObject({ conflicts: [{ reasons: ['room', 'coach'] }] });
  });

  it('lets back-to-back classes, another room, the class itself and deleted classes through', async () => {
    expect(await check([slot('2099-01-05T10:00:00Z', 60, ROOM_A, COACH)])).toEqual({ kind: 'ok' });
    expect(await check([slot('2099-01-05T08:00:00Z', 60, ROOM_A, COACH)])).toEqual({ kind: 'ok' });
    expect(await check([slot('2099-01-05T09:00:00Z', 60, ROOM_B, null)])).toEqual({ kind: 'ok' });
    expect(await check([slot('2099-01-05T09:15:00Z', 60, ROOM_A, COACH)], [YOGA])).toEqual({
      kind: 'ok',
    });
    await asOwner(`UPDATE classes SET deleted_at = now() WHERE id = '${YOGA}'`);
    expect(await check([slot('2099-01-05T09:15:00Z', 60, ROOM_A, COACH)])).toEqual({ kind: 'ok' });
  });

  it("refuses a deleted room and another studio's room, even with the override", async () => {
    await createRoomsRepo(db, admin).remove(ROOM_B);
    for (const roomId of [ROOM_B, FOREIGN_ROOM]) {
      expect(
        await checkPlacementAsTenant(db, admin, [slot('2099-02-01T09:00:00Z', 60, roomId, null)], {
          allowConflicts: true,
        }),
      ).toEqual({ kind: 'room_not_found' });
    }
  });
});

describe('series', () => {
  const SERIES: CreateClassSeriesRequest = {
    title: 'Morning flow',
    startsAt: '2099-01-06T08:00:00.000Z',
    durationMin: 60,
    capacity: 12,
    roomId: ROOM_A,
    coachId: COACH as CreateClassSeriesRequest['coachId'],
    recurrence: { weekdays: [2, 4], count: 4 },
    timeZone: 'Europe/Paris',
  };
  const STARTS = [
    '2099-01-06T08:00:00.000Z',
    '2099-01-08T08:00:00.000Z',
    '2099-01-13T08:00:00.000Z',
    '2099-01-15T08:00:00.000Z',
  ].map((iso) => new Date(iso));

  async function createSeries() {
    const outcome = await createSeriesRepo(db, admin).create(SERIES, STARTS);
    if (outcome.kind !== 'created') throw new Error(`series not created: ${outcome.kind}`);
    return outcome;
  }

  it('creates every occurrence with one series id, in one transaction', async () => {
    const outcome = await createSeries();
    expect(outcome.rows.map((r) => r.startsAt.toISOString())).toEqual(
      STARTS.map((d) => d.toISOString()),
    );
    expect(new Set(outcome.rows.map((r) => r.seriesId))).toEqual(new Set([outcome.seriesId]));
    expect(outcome.rows.every((r) => r.roomId === ROOM_A && r.version === 0)).toBe(true);
  });

  it('refuses a clash with nothing inserted, and schedules it with the override', async () => {
    const clashing = [...STARTS, new Date('2099-01-05T09:30:00.000Z')];
    const refused = await createSeriesRepo(db, admin).create(SERIES, clashing);
    expect(refused).toMatchObject({
      kind: 'schedule_conflict',
      conflicts: [{ classId: YOGA, occurrenceStartsAt: '2099-01-05T09:30:00.000Z' }],
    });
    expect(await asOwner(`SELECT id FROM classes WHERE series_id IS NOT NULL`)).toEqual([]);
    const forced = await createSeriesRepo(db, admin).create(
      { ...SERIES, allowConflicts: true },
      clashing,
    );
    expect(forced).toMatchObject({ kind: 'created' });
  });

  it('refuses an occurrence in the past', async () => {
    const outcome = await createSeriesRepo(db, admin).create(SERIES, [
      new Date('2020-01-01T08:00:00Z'),
      ...STARTS,
    ]);
    expect(outcome).toEqual({ kind: 'starts_at_in_past' });
  });

  it('edits this and the later occurrences, retimed in the series time zone', async () => {
    const { seriesId, rows } = await createSeries();
    const anchor = rows[1];
    if (anchor === undefined) throw new Error('no anchor');
    const outcome = await createSeriesRepo(db, admin).update(seriesId, {
      fromClassId: anchor.id as never,
      version: 0,
      startTime: '18:30',
      timeZone: 'Europe/Paris',
      capacity: 8,
      roomId: ROOM_B,
    });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.rows.map((r) => r.startsAt.toISOString())).toEqual([
      '2099-01-08T17:30:00.000Z',
      '2099-01-13T17:30:00.000Z',
      '2099-01-15T17:30:00.000Z',
    ]);
    expect(
      outcome.rows.every((r) => r.capacity === 8 && r.roomId === ROOM_B && r.version === 1),
    ).toBe(true);
    expect([...outcome.remaining.values()]).toEqual([8, 8, 8]);
    const first = await asOwner<{ version: number; capacity: number }>(
      `SELECT version, capacity FROM classes WHERE id = '${rows[0]?.id ?? ''}'`,
    );
    expect(first).toEqual([{ version: 0, capacity: 12 }]);
  });

  it('a stale anchor version is a version conflict', async () => {
    const { seriesId, rows } = await createSeries();
    const outcome = await createSeriesRepo(db, admin).update(seriesId, {
      fromClassId: (rows[0]?.id ?? '') as never,
      version: 3,
      title: 'Stale',
    });
    expect(outcome).toEqual({ kind: 'version_conflict' });
  });

  it('refuses a capacity under the bookings of one occurrence and changes none', async () => {
    const { seriesId, rows } = await createSeries();
    const booked = rows[2]?.id ?? '';
    await asOwner(`
      INSERT INTO reservations (class_id, user_id, status) VALUES ('${booked}', '${MEMBER}', 'confirmed');
      INSERT INTO reservations (class_id, user_id, status) VALUES ('${booked}', '${COACH}', 'confirmed');
    `);
    const outcome = await createSeriesRepo(db, admin).update(seriesId, {
      fromClassId: (rows[0]?.id ?? '') as never,
      version: 0,
      capacity: 1,
      title: 'Smaller',
    });
    expect(outcome).toEqual({ kind: 'capacity_below_confirmed', classId: booked });
    const titles = await asOwner<{ title: string }>(
      `SELECT DISTINCT title FROM classes WHERE series_id = '${seriesId}'`,
    );
    expect(titles).toEqual([{ title: 'Morning flow' }]);
  });

  it('a series move that lands on another class is a conflict, unless overridden', async () => {
    const { seriesId, rows } = await createSeries();
    await asOwner(`
      INSERT INTO classes (studio_id, room_id, title, starts_at, duration_min, capacity)
      VALUES ('${STUDIO}', '${ROOM_B}', 'Spin', '2099-01-13T17:00:00+00', 60, 10);
    `);
    const patch = {
      fromClassId: (rows[0]?.id ?? '') as never,
      version: 0,
      roomId: ROOM_B,
      startTime: '18:30',
      timeZone: 'Europe/Paris',
    };
    expect(await createSeriesRepo(db, admin).update(seriesId, patch)).toMatchObject({
      kind: 'schedule_conflict',
      conflicts: [{ title: 'Spin', occurrenceStartsAt: '2099-01-13T17:30:00.000Z' }],
    });
    expect(
      await createSeriesRepo(db, admin).update(seriesId, { ...patch, allowConflicts: true }),
    ).toMatchObject({ kind: 'updated' });
  });

  it('deletes this and the later occurrences and cancels their bookings', async () => {
    const { seriesId, rows } = await createSeries();
    const later = rows[3]?.id ?? '';
    await asOwner(
      `INSERT INTO reservations (class_id, user_id, status) VALUES ('${later}', '${MEMBER}', 'confirmed')`,
    );
    const outcome = await createSeriesRepo(db, admin).remove(seriesId, rows[2]?.id ?? '');
    expect(outcome).toEqual({ kind: 'deleted', count: 2 });
    const live = await asOwner<{ id: string }>(
      `SELECT id FROM classes WHERE series_id = '${seriesId}' AND deleted_at IS NULL ORDER BY starts_at`,
    );
    expect(live.map((r) => r.id)).toEqual([rows[0]?.id, rows[1]?.id]);
    expect(
      await asOwner<{ status: string }>(
        `SELECT status FROM reservations WHERE class_id = '${later}'`,
      ),
    ).toEqual([{ status: 'cancelled' }]);
    expect(await createSeriesRepo(db, admin).remove(seriesId, YOGA)).toEqual({ kind: 'not_found' });
  });

  it('a member cannot create a series (RLS)', async () => {
    await expect(createSeriesRepo(db, member).create(SERIES, STARTS)).rejects.toThrow();
  });
});
