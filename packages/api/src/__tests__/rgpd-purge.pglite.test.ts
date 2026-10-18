/**
 * Runs `anonymizeExpiredUsers` against a real Postgres engine (PGlite)
 * with the production `users` table, so the UPDATE is checked against
 * the actual column constraints and not only as a string (issue #628).
 *
 * Before migration 0041 `users.email` was NOT NULL and every purge tick
 * failed with SQLSTATE 23502. The role and RLS side (the statement runs
 * as `athlya_cron`) is covered by the `users_email_nullable.sql` pgTAP
 * suite; PGlite has no `athlya_*` roles.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { anonymizeExpiredUsers, type SqlExecutor } from '../maintenance/rgpd-purge.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../db/migrations');

function migration(name: string): string {
  return readFileSync(resolve(migrationsDir, name), 'utf8');
}

async function bootDb(migrations: readonly string[]): Promise<PGlite> {
  const pglite = new PGlite({ extensions: { citext, pgcrypto } });
  for (const name of migrations) {
    await pglite.exec(migration(name));
  }
  return pglite;
}

function executorFor(pglite: PGlite): SqlExecutor {
  return {
    async execute(query, params) {
      const result = await pglite.query(query, [...params]);
      return result.affectedRows ?? 0;
    },
  };
}

const NOW = new Date('2026-06-15T12:00:00.000Z');
const clock = { now: () => NOW };

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPIRED_OLD = '11111111-1111-4111-8111-000000000001';
const EXPIRED_NEW = '11111111-1111-4111-8111-000000000002';
const RECENT = '11111111-1111-4111-8111-000000000003';
const LIVE = '11111111-1111-4111-8111-000000000004';

const CONSENTS = JSON.stringify({
  marketing: true,
  analytics: true,
  thirdParty: false,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
});

async function seed(pglite: PGlite): Promise<void> {
  await pglite.exec('TRUNCATE users, studios CASCADE');
  await pglite.query(`INSERT INTO studios (id, name, slug) VALUES ($1, 'Studio', 'studio')`, [
    STUDIO,
  ]);
  const insert = `
    INSERT INTO users (id, studio_id, email, display_name, avatar_url, password_hash, role, consents, deleted_at)
    VALUES ($1, $2, $3, $4, 'https://cdn.example.com/a.png', 'hash', 'member', $5::jsonb, $6)
  `;
  await pglite.query(insert, [
    EXPIRED_OLD,
    STUDIO,
    'old@purge.test',
    'Old',
    CONSENTS,
    '2026-04-01T00:00:00Z',
  ]);
  await pglite.query(insert, [
    EXPIRED_NEW,
    STUDIO,
    'new@purge.test',
    'New',
    CONSENTS,
    '2026-05-10T00:00:00Z',
  ]);
  await pglite.query(insert, [
    RECENT,
    STUDIO,
    'recent@purge.test',
    'Recent',
    CONSENTS,
    '2026-06-01T00:00:00Z',
  ]);
  await pglite.query(insert, [LIVE, STUDIO, 'live@purge.test', 'Live', CONSENTS, null]);
}

interface UserState {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly password_hash: string | null;
  readonly consents: unknown;
  readonly deleted_at: Date | null;
}

async function usersById(pglite: PGlite): Promise<Map<string, UserState>> {
  const { rows } = await pglite.query<UserState>(
    `SELECT id, email::text AS email, display_name, avatar_url, password_hash, consents, deleted_at
       FROM users ORDER BY id`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

describe('anonymizeExpiredUsers on the init schema without 0041 (issue #628)', () => {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = await bootDb(['0000_init.sql']);
    await seed(pglite);
  }, 60_000);

  afterAll(async () => {
    await pglite.close();
  });

  it('fails with a not-null violation on users.email', async () => {
    await expect(anonymizeExpiredUsers(executorFor(pglite), { clock })).rejects.toMatchObject({
      code: '23502',
    });
  });
});

describe('anonymizeExpiredUsers with migration 0041 (issue #628)', () => {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = await bootDb(['0000_init.sql', '0041_users_email_nullable.sql']);
  }, 60_000);

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    await seed(pglite);
  });

  it('anonymises every user soft-deleted before the cutoff', async () => {
    const result = await anonymizeExpiredUsers(executorFor(pglite), { clock });

    expect(result).toEqual({ anonymizedCount: 2, hasMore: false });
    const users = await usersById(pglite);
    for (const id of [EXPIRED_OLD, EXPIRED_NEW]) {
      expect(users.get(id)).toMatchObject({
        email: null,
        display_name: '[deleted]',
        avatar_url: null,
        password_hash: null,
        consents: {},
      });
      expect(users.get(id)?.deleted_at).not.toBeNull();
    }
  });

  it('leaves users inside the retention window and live users untouched', async () => {
    await anonymizeExpiredUsers(executorFor(pglite), { clock });

    const users = await usersById(pglite);
    expect(users.get(RECENT)).toMatchObject({ email: 'recent@purge.test', display_name: 'Recent' });
    expect(users.get(LIVE)).toMatchObject({
      email: 'live@purge.test',
      display_name: 'Live',
      password_hash: 'hash',
      deleted_at: null,
    });
  });

  it('is idempotent: a second pass anonymises nothing', async () => {
    const exec = executorFor(pglite);
    await anonymizeExpiredUsers(exec, { clock });

    const again = await anonymizeExpiredUsers(exec, { clock });

    expect(again).toEqual({ anonymizedCount: 0, hasMore: false });
  });

  it('drains a backlog oldest first, one batch per call', async () => {
    const exec = executorFor(pglite);

    const first = await anonymizeExpiredUsers(exec, { clock, batchLimit: 1 });
    const afterFirst = await usersById(pglite);

    expect(first).toEqual({ anonymizedCount: 1, hasMore: true });
    expect(afterFirst.get(EXPIRED_OLD)?.email).toBeNull();
    expect(afterFirst.get(EXPIRED_NEW)?.email).toBe('new@purge.test');

    const second = await anonymizeExpiredUsers(exec, { clock, batchLimit: 1 });
    const third = await anonymizeExpiredUsers(exec, { clock, batchLimit: 1 });

    expect(second).toEqual({ anonymizedCount: 1, hasMore: true });
    expect(third).toEqual({ anonymizedCount: 0, hasMore: false });
  });

  it('lets the address of an anonymised user be registered again', async () => {
    await anonymizeExpiredUsers(executorFor(pglite), { clock });

    await expect(
      pglite.query(
        `INSERT INTO users (studio_id, email, display_name, role, consents)
         VALUES ($1, 'old@purge.test', 'Back', 'member', $2::jsonb)`,
        [STUDIO, CONSENTS],
      ),
    ).resolves.toMatchObject({ affectedRows: 1 });
  });
});
