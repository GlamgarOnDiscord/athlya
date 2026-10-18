import { lookup, store } from '@athlya/db/idempotency';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { createTenantIdempotencyDb } from '../../adapters/tenant-idempotency.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/**
 * `idempotency_keys` is owner-scoped by RLS: every statement of the
 * idempotency store must reach Neon in the same HTTP transaction as the
 * caller's tenant GUCs (issue #640).
 */

const dialect = new PgDialect();
const claims: TenantClaims = {
  userId: '11111111-1111-4111-8111-111111111111',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'member',
};

function fakeHttpDb(rows: unknown[]) {
  const batches: { sql: string; params: unknown[] }[][] = [];
  const db = {
    execute: (query: SQL) => dialect.sqlToQuery(query),
    batch(items: { sql: string; params: unknown[] }[]) {
      batches.push(items);
      return Promise.resolve([{ rows: [] }, { rows: [] }, { rows: [] }, { rows }]);
    },
  };
  return { db: db as unknown as AthlyaDbHttp, batches };
}

describe('createTenantIdempotencyDb', () => {
  it('runs lookup after the three tenant GUCs and returns the rows array', async () => {
    const createdAt = new Date('2026-10-18T10:00:00.000Z');
    const { db, batches } = fakeHttpDb([
      { response: { ok: true }, status_code: 201, created_at: createdAt, expires_at: createdAt },
    ]);
    const hit = await lookup(createTenantIdempotencyDb(db, claims), 'key-1', claims.userId);
    expect(hit).toMatchObject({ response: { ok: true }, statusCode: 201 });

    expect(batches).toHaveLength(1);
    const [userGuc, studioGuc, roleGuc, query] = batches[0] ?? [];
    expect(userGuc?.sql).toContain(`'app.user_id'`);
    expect(userGuc?.params).toEqual([claims.userId]);
    expect(studioGuc?.sql).toContain(`'app.studio_id'`);
    expect(studioGuc?.params).toEqual([claims.studioId]);
    expect(roleGuc?.sql).toContain(`'app.role'`);
    expect(roleGuc?.params).toEqual(['member']);
    expect(query?.sql).toContain('FROM idempotency_keys');
  });

  it('runs store in the same tenant scope', async () => {
    const { db, batches } = fakeHttpDb([]);
    await store(createTenantIdempotencyDb(db, claims), 'key-1', claims.userId, {
      body: { id: 'p1' },
      statusCode: 201,
    });
    expect(batches[0]?.[3]?.sql).toContain('INSERT INTO idempotency_keys');
    expect(batches[0]?.[0]?.params).toEqual([claims.userId]);
  });

  it('treats a result without rows as a miss', async () => {
    const db = {
      execute: (query: SQL) => dialect.sqlToQuery(query),
      batch: () => Promise.resolve([{}, {}, {}, { rowCount: 0 }]),
    } as unknown as AthlyaDbHttp;
    await expect(lookup(createTenantIdempotencyDb(db, claims), 'k', claims.userId)).resolves.toBe(
      null,
    );
  });
});
