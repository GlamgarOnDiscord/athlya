/**
 * `createCalendarFeedRepoHttp` against the real migration chain, run as
 * the `athlya_app` runtime role (issue #719).
 *
 * PGlite applies every forward migration, then the session switches to
 * `athlya_app` (NOBYPASSRLS). A Neon HTTP stand-in runs the tenant GUCs
 * and the statement in one transaction, like `withTenantHttp` does over
 * Neon's batch API, so the assertions below are what the RLS policies
 * let a feed token read.
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

import { createCalendarFeedRepoHttp } from '../../adapters/calendar-deps.js';

import type { AthlyaDb, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const MEMBER_GONE = '11111111-1111-4111-8111-111111111113';
const MEMBER_B = '22222222-2222-4222-8222-222222222221';

const claims = (userId: string, studioId: string): TenantClaims => ({
  userId,
  studioId,
  role: 'member',
});

/** Tuesday 2026-10-20, 12:00 UTC. */
const NOW = new Date('2026-10-20T12:00:00.000Z');

const classId = (n: number) => `cccccccc-cccc-4ccc-8ccc-cccccccccc0${n}`;
const reservationId = (n: number) => `dddddddd-dddd-4ddd-8ddd-dddddddddd0${n}`;

let pglite: PGlite;
let db: AthlyaDb;

function neonHttpLike(): AthlyaDbHttp {
  return {
    execute: (query: SQL) => query,
    batch: (queries: readonly SQL[]) =>
      db.transaction(async (tx) => {
        const results: unknown[] = [];
        for (const query of queries) results.push(await tx.execute(query));
        return results;
      }),
  } as unknown as AthlyaDbHttp;
}

const repo = () => createCalendarFeedRepoHttp(neonHttpLike());

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
      ('${STUDIO_A}', 'studio-a', 'Studio Camille Durand'),
      ('${STUDIO_B}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents, deleted_at)
    SELECT id::uuid, studio::uuid, email, name, 'member'::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
           deleted::timestamptz
      FROM (VALUES
        ('${MEMBER_A}',    '${STUDIO_A}', 'camille@test.dev', 'Camille Durand', NULL),
        ('${MEMBER_A2}',   '${STUDIO_A}', 'a2@test.dev',      'Member A2',      NULL),
        ('${MEMBER_GONE}', '${STUDIO_A}', NULL,               'Gone',           '2026-10-01T00:00:00Z'),
        ('${MEMBER_B}',    '${STUDIO_B}', 'b@test.dev',       'Member B',       NULL)
      ) AS seed (id, studio, email, name, deleted);
    INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version, deleted_at) VALUES
      ('${classId(1)}', '${STUDIO_A}', 'Yoga',      '2026-10-21T18:00:00Z', 45, 10, 2, NULL),
      ('${classId(2)}', '${STUDIO_A}', 'HIIT',      '2026-10-22T07:00:00Z', 30, 10, 0, NULL),
      ('${classId(3)}', '${STUDIO_A}', 'Pilates',   '2026-10-23T07:00:00Z', 30, 10, 0, NULL),
      ('${classId(4)}', '${STUDIO_A}', 'Rebooked',  '2026-10-24T07:00:00Z', 30, 10, 1, NULL),
      ('${classId(5)}', '${STUDIO_A}', 'Far',       '2027-06-01T07:00:00Z', 30, 10, 0, NULL),
      ('${classId(6)}', '${STUDIO_A}', 'Old',       '2026-09-01T07:00:00Z', 30, 10, 0, NULL),
      ('${classId(7)}', '${STUDIO_A}', 'Deleted',   '2026-10-25T07:00:00Z', 60, 10, 3, NULL),
      ('${classId(8)}', '${STUDIO_B}', 'Elsewhere', '2026-10-21T18:00:00Z', 60, 10, 0, NULL);
    INSERT INTO reservations (id, class_id, user_id, status, created_at, cancelled_at) VALUES
      ('${reservationId(1)}', '${classId(1)}', '${MEMBER_A}',  'confirmed', '2026-10-01T09:00:00Z', NULL),
      ('${reservationId(2)}', '${classId(2)}', '${MEMBER_A}',  'cancelled', '2026-10-01T09:00:00Z', '2026-10-05T12:00:00Z'),
      ('${reservationId(3)}', '${classId(3)}', '${MEMBER_A}',  'waitlist',  '2026-10-01T09:00:00Z', NULL),
      ('${reservationId(4)}', '${classId(4)}', '${MEMBER_A}',  'cancelled', '2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z'),
      ('${reservationId(5)}', '${classId(4)}', '${MEMBER_A}',  'confirmed', '2026-10-03T09:00:00Z', NULL),
      ('${reservationId(6)}', '${classId(5)}', '${MEMBER_A}',  'confirmed', '2026-10-01T09:00:00Z', NULL),
      ('${reservationId(7)}', '${classId(6)}', '${MEMBER_A}',  'confirmed', '2026-08-01T09:00:00Z', NULL),
      ('${reservationId(8)}', '${classId(7)}', '${MEMBER_A}',  'confirmed', '2026-10-01T09:00:00Z', NULL),
      ('${reservationId(9)}', '${classId(1)}', '${MEMBER_A2}', 'confirmed', '2026-10-01T09:00:00Z', NULL);
    INSERT INTO reservations (class_id, user_id, status) VALUES
      ('${classId(8)}', '${MEMBER_B}', 'confirmed');
    -- Deleted after the booking: the capacity trigger refuses bookings on deleted classes.
    UPDATE classes SET deleted_at = '2026-10-19T10:00:00Z' WHERE id = '${classId(7)}';
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('createCalendarFeedRepoHttp under athlya_app', () => {
  it('runs as a NOBYPASSRLS role', async () => {
    const { rows } = await pglite.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('reads the member confirmed and cancelled bookings in the window, no waitlist', async () => {
    const snapshot = await repo().readFeed(claims(MEMBER_A, STUDIO_A), NOW);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.credentialsVersion).toBe(1);
    expect(snapshot?.studioName).toBe('Studio Camille Durand');
    expect(snapshot?.events).toEqual([
      {
        reservationId: reservationId(1),
        classTitle: 'Yoga',
        startsAt: new Date('2026-10-21T18:00:00.000Z'),
        durationMin: 45,
        classVersion: 2,
        status: 'confirmed',
        updatedAt: new Date('2026-10-01T09:00:00.000Z'),
      },
      {
        reservationId: reservationId(2),
        classTitle: 'HIIT',
        startsAt: new Date('2026-10-22T07:00:00.000Z'),
        durationMin: 30,
        classVersion: 0,
        status: 'cancelled',
        updatedAt: new Date('2026-10-05T12:00:00.000Z'),
      },
      {
        reservationId: reservationId(5),
        classTitle: 'Rebooked',
        startsAt: new Date('2026-10-24T07:00:00.000Z'),
        durationMin: 30,
        classVersion: 1,
        status: 'confirmed',
        updatedAt: new Date('2026-10-03T09:00:00.000Z'),
      },
      {
        reservationId: reservationId(8),
        classTitle: 'Deleted',
        startsAt: new Date('2026-10-25T07:00:00.000Z'),
        durationMin: 60,
        classVersion: 3,
        status: 'cancelled',
        updatedAt: new Date('2026-10-19T10:00:00.000Z'),
      },
    ]);
  });

  it('never returns another member or studio bookings', async () => {
    const snapshot = await repo().readFeed(claims(MEMBER_B, STUDIO_B), NOW);
    expect(snapshot?.studioName).toBe('Studio B');
    expect(snapshot?.events.map((e) => e.classTitle)).toEqual(['Elsewhere']);
  });

  it('returns null when the token studio is not the member studio', async () => {
    await expect(repo().readFeed(claims(MEMBER_A, STUDIO_B), NOW)).resolves.toBeNull();
    await expect(repo().readCredentialsVersion(claims(MEMBER_A, STUDIO_B))).resolves.toBeNull();
  });

  it('returns null for a deleted member', async () => {
    await expect(repo().readFeed(claims(MEMBER_GONE, STUDIO_A), NOW)).resolves.toBeNull();
    await expect(repo().readCredentialsVersion(claims(MEMBER_GONE, STUDIO_A))).resolves.toBeNull();
  });

  it('names an empty calendar for a member without bookings', async () => {
    await pglite.exec(`RESET ROLE;
      INSERT INTO users (id, studio_id, email, display_name, role, consents)
      VALUES ('11111111-1111-4111-8111-111111111119', '${STUDIO_A}', 'new@test.dev', 'New',
              'member', '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb);
      SET ROLE athlya_app;`);
    const snapshot = await repo().readFeed(
      claims('11111111-1111-4111-8111-111111111119', STUDIO_A),
      NOW,
    );
    expect(snapshot).toEqual({
      credentialsVersion: 1,
      studioName: 'Studio Camille Durand',
      events: [],
    });
  });

  it('reports the bumped credentials version that revokes older tokens', async () => {
    await expect(repo().readCredentialsVersion(claims(MEMBER_A2, STUDIO_A))).resolves.toBe(1);
    await pglite.exec(`RESET ROLE;
      UPDATE users SET credentials_version = credentials_version + 1 WHERE id = '${MEMBER_A2}';
      SET ROLE athlya_app;`);
    await expect(repo().readCredentialsVersion(claims(MEMBER_A2, STUDIO_A))).resolves.toBe(2);
    const snapshot = await repo().readFeed(claims(MEMBER_A2, STUDIO_A), NOW);
    expect(snapshot?.credentialsVersion).toBe(2);
  });
});
