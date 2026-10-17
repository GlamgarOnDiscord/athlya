import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmailTakenError } from '@athlya/auth';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { createDrizzleUserRepo } from '../../adapters/auth-user-repo-drizzle.js';
import { createDrizzleDeletionRepo } from '../../adapters/cascade-repo-drizzle.js';
import { buildRecipientRepo } from '../../adapters/notifications-deps.js';
import { queryRows, serviceFn } from '../../adapters/service-functions.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/**
 * Issue #224 — pre-auth and background adapters call the SECURITY
 * DEFINER functions of migration 0032 instead of raw tenant tables.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = resolve(here, '../..');
const migration = readFileSync(
  resolve(here, '../../../../db/migrations/0032_service_definer_functions.sql'),
  'utf8',
);
const dialect = new PgDialect();

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Fake db whose `execute` answers with `respond(call)` in the Neon `{ rows }` shape. */
function fakeDb(respond: (call: Call) => unknown[] | Error, shape: 'neon' | 'pg' = 'neon') {
  const calls: Call[] = [];
  const db = {
    execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query);
      const call = { sql, params };
      calls.push(call);
      const out = respond(call);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(shape === 'neon' ? { rows: out } : out);
    },
  };
  return { db: db as unknown as AthlyaDbAny, calls };
}

const userRow = {
  id: '11111111-1111-4111-8111-111111111111',
  studio_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'member@athlya.test',
  display_name: 'Member',
  role: 'member',
  password_hash: 'hash',
  deleted_at: null,
  credentials_version: 3,
};

describe('service function contract with migration 0032', () => {
  const source = readFileSync(resolve(apiSrc, 'adapters/service-functions.ts'), 'utf8');
  const used = [...source.matchAll(/\b((?:auth|rgpd|notification)_[a-z_]+)\(/gu)].map((m) => m[1]);

  it('references at least the 13 service functions', () => {
    expect(new Set(used).size).toBe(13);
  });

  it.each([...new Set(used)])('%s is created and granted to athlya_app by the migration', (fn) => {
    expect(migration).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`, 'u'));
    expect(migration).toMatch(new RegExp(`'${fn}\\(`, 'u'));
  });
});

describe('RLS inventory — claim-less adapters never touch tenant tables directly', () => {
  const tenantTables = [
    'users',
    'studios',
    'pushTokens',
    'reservations',
    'workoutSessions',
    'idempotencyKeys',
  ];
  it.each([
    'adapters/auth-user-repo-drizzle.ts',
    'adapters/notifications-deps.ts',
    'adapters/cascade-repo-drizzle.ts',
    'adapters/password-reset-repo-drizzle.ts',
  ])('%s imports no tenant table from @athlya/db/schema', (file) => {
    const text = readFileSync(resolve(apiSrc, file), 'utf8');
    const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@athlya\/db\/schema'/gu)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    expect(imports.filter((name) => tenantTables.includes(name))).toEqual([]);
  });
});

describe('queryRows', () => {
  it('reads Neon HTTP `{ rows }` and postgres-js arrays alike', async () => {
    const neon = fakeDb(() => [{ n: 1 }], 'neon');
    const pg = fakeDb(() => [{ n: 1 }], 'pg');
    await expect(queryRows(neon.db, serviceFn.deleteReservations('u'))).resolves.toEqual([
      { n: 1 },
    ]);
    await expect(queryRows(pg.db, serviceFn.deleteReservations('u'))).resolves.toEqual([{ n: 1 }]);
  });
});

describe('createDrizzleUserRepo', () => {
  it('maps the snake_case function row to UserRow', async () => {
    const { db, calls } = fakeDb(() => [{ ...userRow, deleted_at: '2026-10-01T00:00:00.000Z' }]);
    const user = await createDrizzleUserRepo(db).findUserById(userRow.id);
    expect(calls[0]?.sql).toContain('auth_find_user_by_id(');
    expect(calls[0]?.params).toEqual([userRow.id]);
    expect(user).toEqual({
      id: userRow.id,
      studioId: userRow.studio_id,
      email: userRow.email,
      displayName: userRow.display_name,
      role: 'member',
      passwordHash: 'hash',
      deletedAt: new Date('2026-10-01T00:00:00.000Z'),
      credentialsVersion: 3,
    });
  });

  it('looks users up by email through the active-user function', async () => {
    const { db, calls } = fakeDb(() => []);
    await expect(createDrizzleUserRepo(db).findUserByEmail('x@athlya.test')).resolves.toBeNull();
    expect(calls[0]?.sql).toContain('auth_find_active_user_by_email(');
  });

  it('resolves studios by slug', async () => {
    const { db } = fakeDb(() => [{ id: 's1', slug: 'studio-a', name: 'Studio A' }]);
    await expect(createDrizzleUserRepo(db).findStudioBySlug('studio-a')).resolves.toEqual({
      id: 's1',
      slug: 'studio-a',
      name: 'Studio A',
    });
  });

  it('registers members and serialises consents as JSON', async () => {
    const consents = {
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: '1',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const { db, calls } = fakeDb(() => [userRow]);
    await createDrizzleUserRepo(db).createUser({
      studioId: userRow.studio_id,
      email: userRow.email,
      displayName: userRow.display_name,
      passwordHash: 'hash',
      role: 'member',
      consents,
    });
    expect(calls[0]?.sql).toContain('auth_create_member(');
    expect(calls[0]?.params).toContain(JSON.stringify(consents));
  });

  it('maps a unique violation to EmailTakenError', async () => {
    const { db } = fakeDb(() => Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(
      createDrizzleUserRepo(db).createUser({
        studioId: userRow.studio_id,
        email: userRow.email,
        displayName: 'Dup',
        passwordHash: 'hash',
        role: 'member',
        consents: {} as never,
      }),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('refuses to create a non-member account', async () => {
    const { db, calls } = fakeDb(() => [userRow]);
    await expect(
      createDrizzleUserRepo(db).createUser({
        studioId: userRow.studio_id,
        email: userRow.email,
        displayName: 'Admin',
        passwordHash: 'hash',
        role: 'admin',
        consents: {} as never,
      }),
    ).rejects.toThrow(/only member/u);
    expect(calls).toHaveLength(0);
  });

  it('soft-deletes and bumps credentials through their functions', async () => {
    const { db, calls } = fakeDb(() => []);
    const repo = createDrizzleUserRepo(db);
    await repo.softDeleteUser(userRow.id);
    await repo.bumpCredentialsVersion(userRow.id);
    expect(calls.map((c) => c.sql)).toEqual([
      expect.stringContaining('auth_soft_delete_user('),
      expect.stringContaining('auth_bump_credentials_version('),
    ]);
  });
});

describe('buildRecipientRepo', () => {
  it('returns the recipient with its push tokens', async () => {
    const { db } = fakeDb(() => [
      { id: userRow.id, email: userRow.email, consents: { marketing: true }, push_tokens: ['t1'] },
    ]);
    await expect(buildRecipientRepo(db).getRecipient(userRow.id)).resolves.toEqual({
      userId: userRow.id,
      email: userRow.email,
      pushTokens: ['t1'],
      consents: { marketing: true },
      locale: 'fr',
    });
  });

  it('returns null for an unknown or deleted user', async () => {
    const { db } = fakeDb(() => []);
    await expect(buildRecipientRepo(db).getRecipient(userRow.id)).resolves.toBeNull();
  });
});

describe('createDrizzleDeletionRepo', () => {
  it('returns the row counts of the rgpd_delete_* functions', async () => {
    const counts: Record<string, number> = {
      rgpd_delete_reservations: 2,
      rgpd_delete_workout_sessions: 1,
      rgpd_delete_push_tokens: 3,
      rgpd_delete_idempotency_keys: 0,
    };
    const { db } = fakeDb((call) => {
      const fn = Object.keys(counts).find((name) => call.sql.includes(`${name}(`));
      return [{ n: fn === undefined ? 0 : counts[fn] }];
    });
    const repo = createDrizzleDeletionRepo(db);
    await expect(repo.deleteReservationsForUser(userRow.id)).resolves.toBe(2);
    await expect(repo.deleteWorkoutSessionsForUser(userRow.id)).resolves.toBe(1);
    await expect(repo.deletePushTokensForUser(userRow.id)).resolves.toBe(3);
    await expect(repo.deleteIdempotencyKeysForUser(userRow.id)).resolves.toBe(0);
  });

  it('re-stamps the tombstone through rgpd_restamp_user_deleted', async () => {
    const { db, calls } = fakeDb(() => []);
    await createDrizzleDeletionRepo(db).markUserDeleted(
      userRow.id,
      new Date('2026-10-12T00:00:00.000Z'),
    );
    expect(calls[0]?.sql).toContain('rgpd_restamp_user_deleted(');
    expect(calls[0]?.params).toEqual([userRow.id, '2026-10-12T00:00:00.000Z']);
  });
});
