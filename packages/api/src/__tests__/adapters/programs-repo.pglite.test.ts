/**
 * `createDrizzleProgramRepo` against the real migration chain, run as
 * the `athlya_app` runtime role (Epic 24, issue #640).
 *
 * PGlite applies every forward migration, so the 0042 policies, the
 * subscription trigger and the composite keys are the production ones.
 * The session switches to `athlya_app` (NOBYPASSRLS) after seeding:
 * every repo call then goes through `withTenant`, and the assertions
 * below are what RLS lets each caller see and do — including another
 * studio's admin, who gets `null` / `not_found` (404 at the wire).
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

import { createDrizzleDeletionRepo } from '../../adapters/cascade-repo-drizzle.js';
import { createDrizzleProgramRepo } from '../../adapters/programs-repo-drizzle.js';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { ProgramWeekInput } from '@athlya/shared/schemas/api';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_A = '11111111-1111-4111-8111-111111111113';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const ADMIN_B = '22222222-2222-4222-8222-222222222222';

const adminA: TenantClaims = { userId: ADMIN_A, studioId: STUDIO_A, role: 'admin' };
const memberA: TenantClaims = { userId: MEMBER_A, studioId: STUDIO_A, role: 'member' };
const memberA2: TenantClaims = { userId: MEMBER_A2, studioId: STUDIO_A, role: 'member' };
const adminB: TenantClaims = { userId: ADMIN_B, studioId: STUDIO_B, role: 'admin' };

const WEEKS: ProgramWeekInput[] = [
  {
    weekNumber: 1,
    title: 'Base',
    workouts: [
      {
        dayNumber: 1,
        title: 'Squat day',
        exercises: [{ name: 'Back squat', sets: 5, reps: 5, weightKg: 80 }],
      },
      {
        dayNumber: 3,
        title: 'Run',
        notes: 'Easy',
        exercises: [{ name: 'Run', sets: 1, durationSec: 1800 }],
      },
    ],
  },
  { weekNumber: 2, workouts: [{ dayNumber: 2, title: 'Pull day', exercises: [] }] },
];

let pglite: PGlite;
let db: AthlyaDb;

const repo = (claims: TenantClaims) => createDrizzleProgramRepo(db, claims);

/** Run a raw query as the migration owner, then switch back to athlya_app. */
async function asOwner<T>(query: string): Promise<T[]> {
  await pglite.exec('RESET ROLE');
  try {
    return (await pglite.query<T>(query)).rows;
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
    // PGlite runs a multi-statement exec as one implicit transaction,
    // where CONCURRENTLY is refused; on an empty in-memory database a
    // plain index build is equivalent.
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES
      ('${STUDIO_A}', 'studio-a', 'Studio A'),
      ('${STUDIO_B}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    SELECT id::uuid, studio::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${ADMIN_A}',   '${STUDIO_A}', 'admin-a@test.dev',   'Admin A',   'admin'),
        ('${MEMBER_A}',  '${STUDIO_A}', 'member-a@test.dev',  'Member A',  'member'),
        ('${MEMBER_A2}', '${STUDIO_A}', 'member-a2@test.dev', 'Member A2', 'member'),
        ('${ADMIN_B}',   '${STUDIO_B}', 'admin-b@test.dev',   'Admin B',   'admin')
      ) AS seed (id, studio, email, name, role);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('createDrizzleProgramRepo under athlya_app', () => {
  let publishedId = '';
  let draftId = '';

  it('runs as a NOBYPASSRLS role', async () => {
    const { rows } = await pglite.query<{ role: string; bypass: boolean; superuser: boolean }>(
      `SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS superuser
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ role: 'athlya_app', bypass: false, superuser: false });
  });

  it('lets an admin create a program with its schedule', async () => {
    const created = await repo(adminA).create({
      studioId: STUDIO_A,
      createdBy: ADMIN_A,
      title: 'Strength 101',
      description: 'Three days a week',
      status: 'published',
      weeks: WEEKS,
    });
    publishedId = created.id;
    expect(created).toMatchObject({
      studioId: STUDIO_A,
      title: 'Strength 101',
      status: 'published',
      version: 0,
      weekCount: 2,
      archivedAt: null,
    });
    expect(created.weeks.map((w) => [w.weekNumber, w.title, w.workouts.length])).toEqual([
      [1, 'Base', 2],
      [2, null, 1],
    ]);
    expect(created.weeks[0]?.workouts[0]?.exercises).toEqual([
      { name: 'Back squat', sets: 5, reps: 5, weightKg: 80 },
    ]);
    expect(created.weeks[0]?.workouts[1]?.notes).toBe('Easy');

    await expect(
      asOwner<{ kind: string }>(
        `SELECT DISTINCT jsonb_typeof(exercises) AS kind FROM program_workouts`,
      ),
    ).resolves.toEqual([{ kind: 'array' }]);

    const draft = await repo(adminA).create({
      studioId: STUDIO_A,
      createdBy: ADMIN_A,
      title: 'Draft',
      description: null,
      status: 'draft',
      weeks: [{ weekNumber: 1, workouts: [] }],
    });
    draftId = draft.id;
  });

  it('refuses program writes from a member', async () => {
    await expect(
      repo(memberA).create({
        studioId: STUDIO_A,
        createdBy: MEMBER_A,
        title: 'Mine',
        description: null,
        status: 'draft',
        weeks: [],
      }),
    ).rejects.toThrow();
    await expect(repo(memberA).update(publishedId, 0, { title: 'Hijacked' })).resolves.toEqual({
      kind: 'conflict',
    });
    expect((await repo(adminA).get(publishedId))?.title).toBe('Strength 101');
  });

  it('shows members the published catalogue only', async () => {
    const listed = await repo(memberA).list({});
    expect(listed.map((p) => p.id)).toEqual([publishedId]);
    expect(listed[0]?.weekCount).toBe(2);
    await expect(repo(memberA).get(draftId)).resolves.toBeNull();
    const staff = await repo(adminA).list({});
    expect(staff.map((p) => p.id).sort()).toEqual([publishedId, draftId].sort());
    await expect(repo(adminA).list({ status: 'draft' })).resolves.toHaveLength(1);
  });

  it('hides studio A from studio B entirely', async () => {
    await expect(repo(adminB).list({})).resolves.toEqual([]);
    await expect(repo(adminB).get(publishedId)).resolves.toBeNull();
    await expect(repo(adminB).update(publishedId, 0, { title: 'Cross' })).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(repo(adminB).archive(publishedId)).resolves.toBeNull();
    await expect(
      repo(adminB).subscribe({
        programId: publishedId,
        studioId: STUDIO_B,
        userId: ADMIN_B,
        startsOn: '2026-10-19',
      }),
    ).resolves.toEqual({ kind: 'not_subscribable' });
    expect((await repo(adminA).get(publishedId))?.title).toBe('Strength 101');
  });

  it('updates with the optimistic lock and replaces the schedule', async () => {
    await expect(repo(adminA).update(publishedId, 7, { title: 'Stale' })).resolves.toEqual({
      kind: 'conflict',
    });
    const outcome = await repo(adminA).update(publishedId, 0, {
      title: 'Strength 102',
      description: null,
      weeks: [{ weekNumber: 1, workouts: [{ dayNumber: 7, title: 'Long run', exercises: [] }] }],
    });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.program).toMatchObject({
      title: 'Strength 102',
      description: null,
      version: 1,
      weekCount: 1,
    });
    expect(outcome.program.weeks[0]?.workouts.map((w) => w.dayNumber)).toEqual([7]);
    // The replaced weeks' workouts are gone, not orphaned.
    await expect(
      asOwner<{ n: number }>(
        `SELECT count(*)::int AS n FROM program_workouts w
           JOIN program_weeks k ON k.id = w.week_id
          WHERE k.program_id = '${publishedId}'`,
      ),
    ).resolves.toEqual([{ n: 1 }]);
    const reread = await repo(adminA).get(publishedId);
    expect(reread?.weeks.flatMap((w) => w.workouts)).toHaveLength(1);
  });

  it('subscribes a member once, to a published program only', async () => {
    const first = await repo(memberA).subscribe({
      programId: publishedId,
      studioId: STUDIO_A,
      userId: MEMBER_A,
      startsOn: '2026-10-12',
    });
    expect(first).toMatchObject({
      kind: 'subscribed',
      subscription: {
        programId: publishedId,
        programTitle: 'Strength 102',
        startsOn: '2026-10-12',
      },
    });
    const second = await repo(memberA).subscribe({
      programId: publishedId,
      studioId: STUDIO_A,
      userId: MEMBER_A,
      startsOn: '2026-10-13',
    });
    expect(second.kind).toBe('already_subscribed');
    if (first.kind === 'subscribed' && second.kind === 'already_subscribed') {
      expect(second.subscription.id).toBe(first.subscription.id);
    }
    await expect(
      repo(memberA).subscribe({
        programId: draftId,
        studioId: STUDIO_A,
        userId: MEMBER_A,
        startsOn: '2026-10-12',
      }),
    ).resolves.toEqual({ kind: 'not_subscribable' });
  });

  it('serves the subscriber schedule and keeps subscriptions private', async () => {
    const schedules = await repo(memberA).listActiveSchedules(MEMBER_A);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.program.weeks[0]?.workouts[0]?.title).toBe('Long run');
    await expect(repo(memberA2).listSubscriptions(MEMBER_A)).resolves.toEqual([]);
    await expect(repo(adminA).listSubscriptions(MEMBER_A)).resolves.toEqual([]);
    await expect(repo(memberA2).cancelSubscription(publishedId, MEMBER_A)).resolves.toBe(false);
  });

  it('archives idempotently; subscribers keep following, edits are refused', async () => {
    const archived = await repo(adminA).archive(publishedId);
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    expect(archived?.archivedAt).not.toBeNull();
    const again = await repo(adminA).archive(publishedId);
    expect(again?.version).toBe(2);

    await expect(repo(adminA).update(publishedId, 2, { title: 'Revive' })).resolves.toEqual({
      kind: 'archived',
    });
    await expect(repo(memberA).list({ status: 'published' })).resolves.toEqual([]);
    const subscriptions = await repo(memberA).listSubscriptions(MEMBER_A);
    expect(subscriptions.map((s) => s.programStatus)).toEqual(['archived']);
    await expect(repo(memberA2).get(publishedId)).resolves.toBeNull();
  });

  it('purges a deleted member subscriptions through the RGPD cascade repo', async () => {
    const fresh = await repo(adminA).create({
      studioId: STUDIO_A,
      createdBy: ADMIN_A,
      title: 'Open',
      description: null,
      status: 'published',
      weeks: [{ weekNumber: 1, workouts: [] }],
    });
    await repo(memberA2).subscribe({
      programId: fresh.id,
      studioId: STUDIO_A,
      userId: MEMBER_A2,
      startsOn: '2026-10-12',
    });
    const cascade = createDrizzleDeletionRepo(db);
    // The cascade runs claim-less under athlya_app: a live account is untouched.
    await expect(cascade.deleteProgramSubscriptionsForUser(MEMBER_A2)).resolves.toBe(0);
    await asOwner(`UPDATE users SET deleted_at = now() WHERE id = '${MEMBER_A2}'`);
    await expect(cascade.deleteProgramSubscriptionsForUser(MEMBER_A2)).resolves.toBe(1);
    await expect(
      asOwner<{ n: number }>(
        `SELECT count(*)::int AS n FROM program_subscriptions WHERE user_id = '${MEMBER_A2}'`,
      ),
    ).resolves.toEqual([{ n: 0 }]);
  });

  it('unsubscribes the caller once', async () => {
    await expect(repo(memberA).cancelSubscription(publishedId, MEMBER_A)).resolves.toBe(true);
    await expect(repo(memberA).cancelSubscription(publishedId, MEMBER_A)).resolves.toBe(false);
    await expect(repo(memberA).listActiveSchedules(MEMBER_A)).resolves.toEqual([]);
    await expect(repo(memberA).get(publishedId)).resolves.toBeNull();
  });
});
