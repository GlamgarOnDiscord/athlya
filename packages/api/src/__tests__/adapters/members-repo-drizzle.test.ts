/**
 * `createDrizzleMemberRepoHttp` and the NULL emails left by the RGPD
 * purge (migration 0041, issue #628).
 *
 * An anonymised user is soft-deleted, so every query already excludes
 * it through `deleted_at IS NULL`. The queries also filter
 * `email IS NOT NULL`, and the row mapper drops a NULL email instead of
 * asserting it, so a member profile never carries a missing address.
 */

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { createDrizzleMemberRepoHttp } from '../../adapters/members-repo-drizzle.js';

import type { AthlyaDbHttp } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111113';
const CLAIMS = { userId: ADMIN, studioId: STUDIO, role: 'admin' as const };

function userRow(id: string, email: string | null, createdAt: string) {
  return {
    id,
    studioId: STUDIO,
    email,
    displayName: `User ${id.slice(-1)}`,
    avatarUrl: null,
    role: 'member' as const,
    consents: {
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
    },
    passwordHash: 'hash',
    credentialsVersion: 1,
    createdAt: new Date(createdAt),
    deletedAt: null,
  };
}

/** Neon HTTP double: the query builder records its WHERE clause, `batch` answers `rows`. */
function fakeHttpDb(rows: unknown[]) {
  const wheres: string[] = [];
  const builder = {
    from: vi.fn(),
    where: vi.fn((condition: SQL) => {
      wheres.push(dialect.sqlToQuery(condition).sql);
      return builder;
    }),
    orderBy: vi.fn(),
    limit: vi.fn(),
    set: vi.fn(),
    returning: vi.fn(),
  };
  for (const step of ['from', 'orderBy', 'limit', 'set', 'returning'] as const) {
    builder[step].mockReturnValue(builder);
  }
  const db = {
    select: vi.fn(() => builder),
    update: vi.fn(() => builder),
    execute: vi.fn(() => ({})),
    batch: vi.fn((items: unknown[]) => {
      expect(items[3]).toBe(builder);
      return Promise.resolve([null, null, null, rows]);
    }),
  };
  return { db: db as unknown as AthlyaDbHttp, wheres };
}

describe('createDrizzleMemberRepoHttp — anonymised users (issue #628)', () => {
  it('filters out NULL emails when reading a profile', async () => {
    const { db, wheres } = fakeHttpDb([]);

    await expect(createDrizzleMemberRepoHttp(db, CLAIMS).findProfile(ADMIN)).resolves.toBeNull();
    expect(wheres[0]).toContain('"deleted_at" is null');
    expect(wheres[0]).toContain('"email" is not null');
  });

  it('maps a row with a NULL email to no profile', async () => {
    const { db } = fakeHttpDb([userRow(ADMIN, null, '2026-01-01T00:00:00Z')]);

    await expect(createDrizzleMemberRepoHttp(db, CLAIMS).findProfile(ADMIN)).resolves.toBeNull();
  });

  it('refuses to report an update on a row with a NULL email', async () => {
    const { db, wheres } = fakeHttpDb([userRow(ADMIN, null, '2026-01-01T00:00:00Z')]);

    await expect(
      createDrizzleMemberRepoHttp(db, CLAIMS).updateProfile(ADMIN, { displayName: 'X' }),
    ).rejects.toThrow('not found or soft-deleted');
    expect(wheres[0]).toContain('"email" is not null');
  });

  it('lists only members with an email', async () => {
    const live = '11111111-1111-4111-8111-111111111111';
    const anonymised = '11111111-1111-4111-8111-111111111112';
    const { db, wheres } = fakeHttpDb([
      userRow(live, 'live@athlya.test', '2026-02-01T00:00:00Z'),
      userRow(anonymised, null, '2026-01-01T00:00:00Z'),
    ]);

    const page = await createDrizzleMemberRepoHttp(db, CLAIMS).listByStudio(STUDIO, { limit: 10 });

    expect(page.items.map((m) => m.email)).toEqual(['live@athlya.test']);
    expect(page.nextCursor).toBeNull();
    expect(wheres[0]).toContain('"deleted_at" is null');
    expect(wheres[0]).toContain('"email" is not null');
  });
});
