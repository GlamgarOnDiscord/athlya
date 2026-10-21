/**
 * Class roster and member file against the real migration chain, run as
 * the `athlya_app` runtime role (issue #746). The reads and the manual
 * check-in go through `withTenant` with the caller's claims, so what the
 * assertions see is what RLS and `checkin_mark_reservation` allow.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDrizzleRosterRepo,
  getRosterWith,
  markAttendanceWith,
} from '../../adapters/class-roster.js';
import { loadMemberFile } from '../../adapters/member-file.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { AthlyaDb } from '@athlya/db/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_A = '11111111-1111-4111-8111-1111111aaaaa';
const COACH_A = '11111111-1111-4111-8111-11111111c0ac';
const COACH_A2 = '11111111-1111-4111-8111-11111111c0ad';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const MEMBER_A3 = '11111111-1111-4111-8111-111111111113';
const ADMIN_B = '22222222-2222-4222-8222-2222222aaaaa';
const CLASS_NOW = 'cccccccc-cccc-4ccc-8ccc-ccccccccc001';
const CLASS_PAST = 'cccccccc-cccc-4ccc-8ccc-ccccccccc002';
const CLASS_NEXT = 'cccccccc-cccc-4ccc-8ccc-ccccccccc003';
const RES_A = 'dddddddd-dddd-4ddd-8ddd-ddddddddd001';
const RES_A2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddd002';
const RES_A3_WAIT = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003';
const RES_A_PAST = 'dddddddd-dddd-4ddd-8ddd-ddddddddd004';
const RES_A_NEXT = 'dddddddd-dddd-4ddd-8ddd-ddddddddd005';

const NOW_MS = Date.parse('2030-01-01T09:10:00Z');

const as = (userId: string, studioId: string, role: AuthClaims['role']): AuthClaims => ({
  userId,
  studioId,
  role,
});
const adminA = as(ADMIN_A, STUDIO_A, 'admin');
const coachA = as(COACH_A, STUDIO_A, 'coach');
const coachA2 = as(COACH_A2, STUDIO_A, 'coach');
const adminB = as(ADMIN_B, STUDIO_B, 'admin');

let pglite: PGlite;
let db: AthlyaDb;

const tenant = (c: AuthClaims) => ({ userId: c.userId, studioId: c.studioId, role: c.role });
const repoFor = (c: AuthClaims) => createDrizzleRosterRepo(db, tenant(c));

beforeAll(async () => {
  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES
      ('${STUDIO_A}', 'studio-a', 'Studio A'),
      ('${STUDIO_B}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    SELECT id::uuid, studio::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":true,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${ADMIN_A}',   '${STUDIO_A}', 'admin-a@test.dev',   'Admin A',   'admin'),
        ('${COACH_A}',   '${STUDIO_A}', 'coach-a@test.dev',   'Coach A',   'coach'),
        ('${COACH_A2}',  '${STUDIO_A}', 'coach-a2@test.dev',  'Coach A2',  'coach'),
        ('${MEMBER_A}',  '${STUDIO_A}', 'member-a@test.dev',  'Member A',  'member'),
        ('${MEMBER_A2}', '${STUDIO_A}', 'member-a2@test.dev', 'Member A2', 'member'),
        ('${MEMBER_A3}', '${STUDIO_A}', 'member-a3@test.dev', 'Member A3', 'member'),
        ('${ADMIN_B}',   '${STUDIO_B}', 'admin-b@test.dev',   'Admin B',   'admin')
      ) AS seed (id, studio, email, name, role);
    INSERT INTO classes (id, studio_id, coach_id, title, starts_at, duration_min, capacity, version) VALUES
      ('${CLASS_NOW}',  '${STUDIO_A}', '${COACH_A}', 'Now',  '2030-01-01 09:00:00+00', 60, 2, 0),
      ('${CLASS_PAST}', '${STUDIO_A}', '${COACH_A}', 'Past', '2029-12-20 09:00:00+00', 60, 10, 0),
      ('${CLASS_NEXT}', '${STUDIO_A}', NULL,         'Next', '2030-01-05 09:00:00+00', 60, 10, 0);
    INSERT INTO reservations (id, class_id, user_id, status, created_at) VALUES
      ('${RES_A}',       '${CLASS_NOW}',  '${MEMBER_A}',  'confirmed', '2029-12-31 10:00:00+00'),
      ('${RES_A2}',      '${CLASS_NOW}',  '${MEMBER_A2}', 'confirmed', '2029-12-31 11:00:00+00'),
      ('${RES_A3_WAIT}', '${CLASS_NOW}',  '${MEMBER_A3}', 'waitlist',  '2029-12-31 12:00:00+00'),
      ('${RES_A_NEXT}',  '${CLASS_NEXT}', '${MEMBER_A}',  'confirmed', '2029-12-31 13:00:00+00');
    INSERT INTO reservations (id, class_id, user_id, status, checked_in_at) VALUES
      ('${RES_A_PAST}', '${CLASS_PAST}', '${MEMBER_A}', 'confirmed', '2029-12-20 08:55:00+00');
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('class roster under athlya_app', () => {
  it('shows the coach of the class who is booked and who waits, in order', async () => {
    const outcome = await getRosterWith(coachA, CLASS_NOW, repoFor(coachA));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.roster.class.coach).toEqual({
      id: COACH_A,
      displayName: 'Coach A',
      avatarUrl: null,
    });
    expect(outcome.roster.confirmed.map((e) => e.member.displayName)).toEqual([
      'Member A',
      'Member A2',
    ]);
    expect(outcome.roster.waitlist.map((e) => e.reservationId)).toEqual([RES_A3_WAIT]);
  });

  it('refuses another coach of the studio and hides the class from another studio', async () => {
    expect(await getRosterWith(coachA2, CLASS_NOW, repoFor(coachA2))).toEqual({
      kind: 'forbidden',
    });
    expect(await getRosterWith(adminB, CLASS_NOW, repoFor(adminB))).toEqual({
      kind: 'not_found',
    });
  });

  it('lets the coach mark a member present once; the waitlist cannot be', async () => {
    const ports = { repo: repoFor(coachA), now: () => NOW_MS };
    const first = await markAttendanceWith(coachA, CLASS_NOW, RES_A, ports);
    expect(first).toMatchObject({
      kind: 'checked_in',
      entry: { reservationId: RES_A, checkedInAt: '2030-01-01T09:10:00.000Z' },
    });
    expect(await markAttendanceWith(coachA, CLASS_NOW, RES_A, ports)).toEqual({
      kind: 'fail',
      reason: 'already_checked_in',
    });
    expect(await markAttendanceWith(coachA, CLASS_NOW, RES_A3_WAIT, ports)).toEqual({
      kind: 'fail',
      reason: 'not_confirmed',
    });
  });

  it('does not let a reservation of another class through the class id', async () => {
    const ports = { repo: repoFor(adminA), now: () => NOW_MS };
    expect(await markAttendanceWith(adminA, CLASS_NOW, RES_A_NEXT, ports)).toEqual({
      kind: 'not_found',
    });
  });

  it('keeps an admin of another studio out of the stamp', async () => {
    const ports = { repo: repoFor(adminB), now: () => NOW_MS };
    expect(await markAttendanceWith(adminB, CLASS_NOW, RES_A2, ports)).toEqual({
      kind: 'not_found',
    });
  });
});

describe('member file under athlya_app', () => {
  it('gives the admin the profile, the next class, the past one and the counts', async () => {
    const file = await loadMemberFile(db, tenant(adminA), MEMBER_A, new Date(NOW_MS));
    expect(file?.member).toMatchObject({
      id: MEMBER_A,
      email: 'member-a@test.dev',
      role: 'member',
      consents: { analytics: true, version: '2026-01' },
    });
    expect(file?.upcoming.map((r) => r.id)).toEqual([RES_A_NEXT]);
    expect(file?.past.map((r) => r.id)).toEqual([RES_A, RES_A_PAST]);
    expect(file?.stats.checkIns).toBe(2);
    expect(file?.stats.lastCheckInAt).toBe('2030-01-01T09:10:00.000Z');
  });

  it('finds nothing for an admin of another studio', async () => {
    expect(await loadMemberFile(db, tenant(adminB), MEMBER_A, new Date(NOW_MS))).toBeNull();
  });
});
