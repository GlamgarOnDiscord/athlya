/**
 * `createDrizzleWorkoutSessionRepo` against the real migration chain,
 * run as the `athlya_app` runtime role (issue #652).
 *
 * PGlite applies every forward migration, then the session switches to
 * `athlya_app` (NOBYPASSRLS): every repo call goes through `withTenant`,
 * so the assertions below are what the owner-only policies of migration
 * 0001 let each caller write and read.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logSession } from '@athlya/members';
import * as schema from '@athlya/db/schema';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WorkoutSessionStudioMismatchError,
  createDrizzleWorkoutSessionRepo,
} from '../../adapters/workout-sessions-repo-drizzle.js';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const ADMIN_A = '11111111-1111-4111-8111-111111111113';

const memberA: TenantClaims = { userId: MEMBER_A, studioId: STUDIO_A, role: 'member' };
const memberA2: TenantClaims = { userId: MEMBER_A2, studioId: STUDIO_A, role: 'member' };
const adminA: TenantClaims = { userId: ADMIN_A, studioId: STUDIO_A, role: 'admin' };

const EXERCISES = [{ name: 'Back squat', sets: [{ reps: 5, weightKg: 80 }] }];

let pglite: PGlite;
let db: AthlyaDb;

const repo = (claims: TenantClaims) => createDrizzleWorkoutSessionRepo(db, claims);

/** Run a raw query as the migration owner, then switch back to athlya_app. */
async function asOwner<T>(query: string): Promise<T[]> {
  await pglite.exec('RESET ROLE');
  try {
    return (await pglite.query<T>(query)).rows;
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

/** SQLSTATE of a driver error, possibly wrapped by Drizzle as `cause`. */
function sqlState(err: unknown): string | undefined {
  const own = (err as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
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
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES ('${STUDIO_A}', 'studio-a', 'Studio A');
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    SELECT id::uuid, '${STUDIO_A}'::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${MEMBER_A}',  'member-a@test.dev',  'Member A',  'member'),
        ('${MEMBER_A2}', 'member-a2@test.dev', 'Member A2', 'member'),
        ('${ADMIN_A}',   'admin-a@test.dev',   'Admin A',   'admin')
      ) AS seed (id, email, name, role);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('createDrizzleWorkoutSessionRepo under athlya_app', () => {
  it('runs as a NOBYPASSRLS role', async () => {
    const { rows } = await pglite.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('stores a session for the caller with the exercises as a jsonb array', async () => {
    const created = await repo(memberA).create({
      userId: MEMBER_A,
      studioId: STUDIO_A,
      startedAt: '2026-10-12T08:00:00.000Z',
      durationMin: 45,
      exercises: EXERCISES,
      notes: 'Felt strong',
    });
    expect(created).toMatchObject({
      userId: MEMBER_A,
      studioId: STUDIO_A,
      startedAt: '2026-10-12T08:00:00.000Z',
      durationMin: 45,
      exercises: EXERCISES,
      notes: 'Felt strong',
    });
    expect(created.createdAt).toMatch(/Z$/u);

    const rows = await asOwner<{ kind: string }>(
      `SELECT jsonb_typeof(exercises) AS kind FROM workout_sessions WHERE id = '${created.id}'`,
    );
    expect(rows[0]?.kind).toBe('array');
  });

  it('stores the cardio summary as a jsonb object and returns it (migration 0046)', async () => {
    const cardio = {
      machine: 'rower',
      durationSec: 1_260,
      distanceM: 5_000,
      avgPowerW: 182,
      strokeCount: 540,
    } as const;
    const created = await logSession(
      MEMBER_A,
      { startedAt: '2026-08-15T07:00:00Z', exercises: [], cardio },
      { repo: repo(memberA) },
    );
    expect(created.cardio).toEqual(cardio);

    const rows = await asOwner<{ kind: string; distance: number }>(
      `SELECT jsonb_typeof(cardio) AS kind, (cardio->>'distanceM')::int AS distance
         FROM workout_sessions WHERE id = '${created.id}'`,
    );
    expect(rows[0]).toEqual({ kind: 'object', distance: 5_000 });

    const listed = await repo(memberA).listByUser(MEMBER_A, {
      from: new Date('2026-08-01T00:00:00Z'),
      to: new Date('2026-09-01T00:00:00Z'),
      limit: 10,
    });
    expect(listed).toEqual([created]);
  });

  it('omits cardio on the wire for a session without one', async () => {
    const created = await repo(memberA).create({
      userId: MEMBER_A,
      startedAt: '2026-09-03T08:00:00.000Z',
      exercises: [],
    });
    expect(created).not.toHaveProperty('cardio');
  });

  it('stores a solo session without a studio through the members use case', async () => {
    const created = await logSession(
      MEMBER_A,
      { startedAt: '2026-10-10T07:00:00Z', exercises: [] },
      { repo: repo(memberA) },
    );
    expect(created.studioId).toBeNull();
    expect(created.durationMin).toBeNull();
    expect(created.notes).toBeNull();
  });

  it('refuses a row owned by another member with 42501 (workout_sessions_insert_own)', async () => {
    const err: unknown = await repo(memberA)
      .create({ userId: MEMBER_A2, startedAt: '2026-10-12T08:00:00.000Z', exercises: [] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(sqlState(err)).toBe('42501');
  });

  it('refuses a studio other than the caller studio before any write', async () => {
    await expect(
      repo(memberA).create({
        userId: MEMBER_A,
        studioId: '99999999-9999-4999-8999-999999999999',
        startedAt: '2026-10-12T08:00:00.000Z',
        exercises: [],
      }),
    ).rejects.toBeInstanceOf(WorkoutSessionStudioMismatchError);
  });

  it('writes one row per (user, idempotency key) and returns it on a retry', async () => {
    const input = {
      userId: MEMBER_A,
      startedAt: '2026-09-01T08:00:00.000Z',
      exercises: [],
      idempotencyKey: 'drain-key-1',
    };
    const first = await repo(memberA).create(input);
    const retry = await repo(memberA).create({ ...input, notes: 'retried payload' });
    expect(retry).toEqual(first);

    const count = await asOwner<{ n: number }>(
      `SELECT count(*)::int AS n FROM workout_sessions WHERE idempotency_key = 'drain-key-1'`,
    );
    expect(count[0]?.n).toBe(1);

    const otherUser = await repo(memberA2).create({ ...input, userId: MEMBER_A2 });
    expect(otherUser.id).not.toBe(first.id);
    expect(otherUser.userId).toBe(MEMBER_A2);
  });

  it('never returns the request key on the wire', async () => {
    const created = await repo(memberA).create({
      userId: MEMBER_A,
      startedAt: '2026-09-02T08:00:00.000Z',
      exercises: [],
      idempotencyKey: 'drain-key-2',
    });
    expect(Object.keys(created)).not.toContain('idempotencyKey');
  });

  it('writes one row per imported workout, whatever the request key', async () => {
    const source = { provider: 'appleHealth', externalId: 'HK-WORKOUT-1' } as const;
    const input = {
      userId: MEMBER_A,
      startedAt: '2026-08-01T07:00:00.000Z',
      durationMin: 30,
      exercises: [{ name: 'Running', sets: [{ reps: 0, durationSec: 1800 }] }],
      source,
    };
    const first = await repo(memberA).create({ ...input, idempotencyKey: 'import-key-1' });
    const reimport = await repo(memberA).create({ ...input, idempotencyKey: 'import-key-2' });
    const withoutKey = await repo(memberA).create({ ...input, notes: 'another locale' });
    expect(reimport).toEqual(first);
    expect(withoutKey).toEqual(first);
    expect(Object.keys(first)).not.toContain('source');
    expect(Object.keys(first)).not.toContain('externalId');

    const rows = await asOwner<{ n: number; source: string; external_id: string }>(
      `SELECT count(*) OVER ()::int AS n, source, external_id
         FROM workout_sessions WHERE external_id = 'HK-WORKOUT-1'`,
    );
    expect(rows).toEqual([{ n: 1, source: 'appleHealth', external_id: 'HK-WORKOUT-1' }]);

    const otherWorkout = await repo(memberA).create({
      ...input,
      source: { provider: 'appleHealth', externalId: 'HK-WORKOUT-2' },
    });
    expect(otherWorkout.id).not.toBe(first.id);

    const otherUser = await repo(memberA2).create({ ...input, userId: MEMBER_A2 });
    expect(otherUser.id).not.toBe(first.id);
    expect(otherUser.userId).toBe(MEMBER_A2);
  });

  it('lists only the caller sessions in the window, newest first', async () => {
    await repo(memberA2).create({
      userId: MEMBER_A2,
      startedAt: '2026-10-11T08:00:00.000Z',
      exercises: [],
    });

    const mine = await repo(memberA).listByUser(MEMBER_A, {
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
      limit: 100,
    });
    expect(mine.map((s) => s.startedAt)).toEqual([
      '2026-10-12T08:00:00.000Z',
      '2026-10-10T07:00:00.000Z',
    ]);

    const outsideWindow = await repo(memberA).listByUser(MEMBER_A, {
      from: new Date('2026-10-11T00:00:00Z'),
      to: new Date('2026-10-12T08:00:00Z'),
      limit: 100,
    });
    expect(outsideWindow).toEqual([]);
  });

  it("hides another member's sessions even when asked by user id, and from an admin", async () => {
    const window = {
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
      limit: 100,
    };
    expect(await repo(memberA2).listByUser(MEMBER_A, window)).toEqual([]);
    expect(await repo(adminA).listByUser(MEMBER_A, window)).toEqual([]);
  });
});
