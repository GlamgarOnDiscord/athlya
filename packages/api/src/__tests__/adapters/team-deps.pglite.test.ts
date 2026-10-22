/**
 * Team adapter and the new roles under the real `athlya_app` role, on
 * PGlite with every forward migration (issue #756): the team listing,
 * invitations, role changes, acceptance, and what a manager and a front
 * desk reach through the roster and the member file.
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

import { createDrizzleRosterRepo, getRosterWith } from '../../adapters/class-roster.js';
import { loadMemberFile } from '../../adapters/member-file.js';
import { createTeamRepo } from '../../adapters/team-deps.js';
import { hashInvitationToken } from '../../routes/team.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { AthlyaDb } from '@athlya/db/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_A = '11111111-1111-4111-8111-1111111aaaaa';
const MANAGER_A = '11111111-1111-4111-8111-1111111aaaab';
const DESK_A = '11111111-1111-4111-8111-1111111aaaac';
const COACH_A = '11111111-1111-4111-8111-11111111c0ac';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const ADMIN_B = '22222222-2222-4222-8222-2222222aaaaa';
const LATE_A = '11111111-1111-4111-8111-111111111119';
const CLASS_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccc001';

const as = (userId: string, studioId: string, role: AuthClaims['role']): AuthClaims => ({
  userId,
  studioId,
  role,
});
const adminA = as(ADMIN_A, STUDIO_A, 'admin');
const managerA = as(MANAGER_A, STUDIO_A, 'manager');
const deskA = as(DESK_A, STUDIO_A, 'accueil');
const adminB = as(ADMIN_B, STUDIO_B, 'admin');

let pglite: PGlite;
let db: AthlyaDb;

const tenant = (c: AuthClaims) => ({ userId: c.userId, studioId: c.studioId, role: c.role });
const future = () => new Date(Date.now() + 7 * 24 * 3_600_000);

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
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${ADMIN_A}',   '${STUDIO_A}', 'admin-a@test.dev',   'Admin A',   'admin'),
        ('${MANAGER_A}', '${STUDIO_A}', 'manager-a@test.dev', 'Manager A', 'manager'),
        ('${DESK_A}',    '${STUDIO_A}', 'desk-a@test.dev',    'Desk A',    'accueil'),
        ('${COACH_A}',   '${STUDIO_A}', 'coach-a@test.dev',   'Coach A',   'coach'),
        ('${MEMBER_A}',  '${STUDIO_A}', 'member-a@test.dev',  'Member A',  'member'),
        ('${MEMBER_A2}', '${STUDIO_A}', 'member-a2@test.dev', 'Member A2', 'member'),
        ('${ADMIN_B}',   '${STUDIO_B}', 'admin-b@test.dev',   'Admin B',   'admin')
      ) AS seed (id, studio, email, name, role);
    INSERT INTO classes (id, studio_id, coach_id, title, starts_at, duration_min, capacity, version) VALUES
      ('${CLASS_A}', '${STUDIO_A}', '${COACH_A}', 'Yoga', '2030-01-01 09:00:00+00', 60, 10, 0);
    INSERT INTO reservations (class_id, user_id, status) VALUES
      ('${CLASS_A}', '${MEMBER_A}', 'confirmed');
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('team adapter under athlya_app', () => {
  it('lists the staff of the studio, the caller first, without members', async () => {
    const team = await createTeamRepo(db).listTeam(managerA);

    expect(team.members.map((m) => [m.displayName, m.role])).toEqual([
      ['Manager A', 'manager'],
      ['Admin A', 'admin'],
      ['Coach A', 'coach'],
      ['Desk A', 'accueil'],
    ]);
    expect(team.invitations).toEqual([]);
  });

  it('turns an invitation of a studio account into a role change at once', async () => {
    const outcome = await createTeamRepo(db).invite(adminA, {
      email: 'member-a2@test.dev',
      role: 'coach',
      tokenHash: await hashInvitationToken('unused-token'),
      expiresAt: future(),
    });

    expect(outcome).toMatchObject({
      kind: 'role_updated',
      member: { id: MEMBER_A2, role: 'coach' },
    });
  });

  it('records a pending invitation for an unknown email, readable by a manager only', async () => {
    const outcome = await createTeamRepo(db).invite(adminA, {
      email: 'newcomer@test.dev',
      role: 'accueil',
      tokenHash: await hashInvitationToken('token-newcomer'),
      expiresAt: future(),
    });

    expect(outcome).toMatchObject({
      kind: 'invited',
      invitation: { email: 'newcomer@test.dev', role: 'accueil' },
    });
    expect((await createTeamRepo(db).listTeam(managerA)).invitations).toHaveLength(1);
    await expect(createTeamRepo(db).listTeam(adminB)).resolves.toMatchObject({ invitations: [] });
  });

  it("refuses a change of the admin's own role and a manager caller", async () => {
    expect(await createTeamRepo(db).setMemberRole(adminA, ADMIN_A, 'member')).toEqual({
      kind: 'own_role',
    });
    await expect(createTeamRepo(db).setMemberRole(managerA, COACH_A, 'admin')).rejects.toThrow();
  });

  it('takes an account off the team and does not reach another studio', async () => {
    expect(await createTeamRepo(db).setMemberRole(adminA, MEMBER_A2, 'member')).toEqual({
      kind: 'updated',
      member: null,
    });
    expect(await createTeamRepo(db).setMemberRole(adminB, COACH_A, 'member')).toEqual({
      kind: 'not_found',
    });
  });

  it('lets the account registered with the invited email accept once, and nobody else', async () => {
    const tokenHash = await hashInvitationToken('token-late');
    await createTeamRepo(db).invite(adminA, {
      email: 'late@test.dev',
      role: 'coach',
      tokenHash,
      expiresAt: future(),
    });
    // The invitee signs up after the invitation was sent.
    await pglite.exec(`
      RESET ROLE;
      INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES
        ('${LATE_A}', '${STUDIO_A}', 'late@test.dev', 'Late A', 'member',
         '{"marketing":false,"analytics":false,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00Z"}'::jsonb);
      SET ROLE athlya_app;
    `);

    const member = as(MEMBER_A, STUDIO_A, 'member');
    const late = as(LATE_A, STUDIO_A, 'member');
    expect(await createTeamRepo(db).acceptInvitation(member, tokenHash)).toBeNull();
    expect(await createTeamRepo(db).acceptInvitation(late, tokenHash)).toBe('coach');
    expect(await createTeamRepo(db).acceptInvitation(late, tokenHash)).toBeNull();
  });

  it('revokes a pending invitation once', async () => {
    const [pending] = (await createTeamRepo(db).listTeam(adminA)).invitations;
    expect(pending).toBeDefined();
    if (pending === undefined) return;
    expect(await createTeamRepo(db).revokeInvitation(adminA, pending.id)).toBe(true);
    expect(await createTeamRepo(db).revokeInvitation(adminA, pending.id)).toBe(false);
  });
});

describe('front desk and manager reach', () => {
  it('lets the front desk and a manager read the roster of a class they do not coach', async () => {
    for (const claims of [deskA, managerA]) {
      const outcome = await getRosterWith(
        claims,
        CLASS_A,
        createDrizzleRosterRepo(db, tenant(claims)),
      );
      expect(outcome.kind).toBe('ok');
    }
  });

  it('opens a member file to the front desk', async () => {
    const file = await loadMemberFile(
      db,
      tenant(deskA),
      MEMBER_A,
      new Date('2029-12-31T00:00:00Z'),
    );
    expect(file?.member.id).toBe(MEMBER_A);
  });
});
