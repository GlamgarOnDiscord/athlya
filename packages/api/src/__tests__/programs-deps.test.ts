import { lookup } from '@athlya/db/idempotency';
import { describe, expect, it, vi } from 'vitest';

import { defaultProgramsDeps, lazyProgramsDeps } from '../domain-deps.js';

import { buildMockEnv } from './helpers/test-app.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { ProgramsDeps } from '../routes/programs.js';
import type { SQL } from 'drizzle-orm';

const httpDb = vi.hoisted(() => ({
  batches: [] as { sql: string; params: unknown[] }[][],
}));

/** The cached Neon HTTP handle, replaced by a recorder of batched statements. */
vi.mock('../adapters/deps-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/deps-cache.js')>();
  const { PgDialect: Dialect } = await import('drizzle-orm/pg-core');
  const dialect = new Dialect();
  return {
    ...actual,
    getOrCreateDbHttp: () => ({
      execute: (query: SQL) => dialect.sqlToQuery(query),
      batch(items: { sql: string; params: unknown[] }[]) {
        httpDb.batches.push(items);
        return Promise.resolve([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
      },
    }),
  };
});

const claims: AuthClaims = {
  userId: '11111111-1111-4111-8111-111111111111',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'member',
};

describe('defaultProgramsDeps', () => {
  it('falls back to the stub bundle without DB_URL', () => {
    const deps = defaultProgramsDeps(buildMockEnv({ DB_URL: '' }));
    expect(() => deps.getToday(claims, undefined)).toThrow(/programs.getToday/u);
    expect(deps.idempotencyFor).toBeUndefined();
  });

  it('wires an idempotency store that runs under the caller tenant claims', async () => {
    const deps = defaultProgramsDeps(
      buildMockEnv({ DB_URL: 'postgres://athlya_app:pw@db.example.test/athlya' }),
    );
    const store = deps.idempotencyFor?.(claims);
    if (store === undefined) throw new Error('idempotency store not wired');
    await expect(lookup(store.db, 'key-1', claims.userId)).resolves.toBeNull();

    const [batch] = httpDb.batches;
    expect(batch?.slice(0, 3).map((stmt) => stmt.params)).toEqual([
      [claims.userId],
      [claims.studioId],
      [claims.role],
    ]);
    expect(batch?.[0]?.sql).toContain(`'app.user_id'`);
    expect(batch?.[1]?.sql).toContain(`'app.studio_id'`);
    expect(batch?.[2]?.sql).toContain(`'app.role'`);
    expect(batch?.[3]?.sql).toContain('FROM idempotency_keys');
  });
});

describe('lazyProgramsDeps', () => {
  it('resolves the bundle per call and forwards the arguments', async () => {
    const getToday = vi.fn().mockResolvedValue({ date: '2026-10-18', items: [] });
    const resolve = vi.fn(() => ({ getToday }) as unknown as ProgramsDeps);
    const lazy = lazyProgramsDeps(resolve);
    expect(resolve).not.toHaveBeenCalled();
    await expect(lazy.getToday(claims, '2026-10-18')).resolves.toEqual({
      date: '2026-10-18',
      items: [],
    });
    expect(getToday).toHaveBeenCalledWith(claims, '2026-10-18');
  });

  it('degrades to no idempotency store when the bundle has none', () => {
    const lazy = lazyProgramsDeps(() => ({}) as ProgramsDeps);
    expect(lazy.idempotencyFor?.(claims)).toBeUndefined();
  });
});
