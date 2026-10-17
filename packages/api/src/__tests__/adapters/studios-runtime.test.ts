import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { createStudioSlugResolver } from '../../adapters/studio-slug-resolver.js';
import { createDrizzleStudioRepoHttp } from '../../adapters/studios-repo-drizzle.js';

import type { AthlyaDbAny, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/**
 * Issue #224 — `studios` is FORCE RLS: the slug guard calls the
 * `studio_id_by_slug` service function and `/v1/studios/me` runs every
 * query inside `withTenantHttp`.
 */

const dialect = new PgDialect();
const STUDIO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const claims: TenantClaims = {
  userId: '11111111-1111-4111-8111-111111111113',
  studioId: STUDIO_ID,
  role: 'admin',
};
const row = {
  id: STUDIO_ID,
  slug: 'studio-a',
  name: 'Studio Alpha',
  brandColor: '#0EA5E9',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

describe('createStudioSlugResolver', () => {
  function fakeDb(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      execute(query: SQL) {
        const { sql, params } = dialect.sqlToQuery(query);
        calls.push({ sql, params });
        return Promise.resolve({ rows });
      },
    };
    return { db: db as unknown as AthlyaDbAny, calls };
  }

  it('resolves the id through studio_id_by_slug', async () => {
    const { db, calls } = fakeDb([{ id: STUDIO_ID }]);
    await expect(createStudioSlugResolver(db)('studio-a')).resolves.toBe(STUDIO_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('studio_id_by_slug(');
    expect(calls[0]?.sql).not.toMatch(/from\s+"?studios"?/iu);
    expect(calls[0]?.params).toEqual(['studio-a']);
  });

  it('returns null for an unknown slug', async () => {
    const { db } = fakeDb([{ id: null }]);
    await expect(createStudioSlugResolver(db)('nope')).resolves.toBeNull();
  });
});

describe('createDrizzleStudioRepoHttp', () => {
  /**
   * Fake Neon HTTP handle: query builders are inert markers and only
   * `batch` resolves, so a query that skipped `withTenantHttp` would
   * never produce rows.
   */
  function fakeHttpDb(result: unknown[]) {
    const batches: { kinds: string[]; set?: unknown; settings: unknown[][] }[] = [];
    const chain = (kind: string, extra: Record<string, unknown> = {}) => {
      const node: Record<string, unknown> = { kind, ...extra };
      for (const m of ['from', 'where', 'limit', 'returning']) node[m] = () => node;
      node['set'] = (values: unknown) => chain(kind, { ...extra, values });
      return node;
    };
    const db = {
      select: () => chain('select'),
      update: () => chain('update'),
      execute: (query: SQL) => ({ kind: 'execute', params: dialect.sqlToQuery(query).params }),
      batch(items: { kind: string; params?: unknown[]; values?: unknown }[]) {
        batches.push({
          kinds: items.map((i) => i.kind),
          set: items[items.length - 1]?.values,
          settings: items.slice(0, -1).map((i) => i.params ?? []),
        });
        return Promise.resolve([null, null, null, result]);
      },
    };
    return { db: db as unknown as AthlyaDbHttp, batches };
  }

  it('reads the studio inside a tenant batch', async () => {
    const { db, batches } = fakeHttpDb([row]);
    await expect(createDrizzleStudioRepoHttp(db, claims).getById(STUDIO_ID)).resolves.toEqual({
      id: STUDIO_ID,
      slug: 'studio-a',
      name: 'Studio Alpha',
      brandColor: '#0EA5E9',
      brandLogo: null,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.kinds).toEqual(['execute', 'execute', 'execute', 'select']);
    expect(batches[0]?.settings).toEqual([[claims.userId], [STUDIO_ID], ['admin']]);
  });

  it('updates the editable columns inside a tenant batch', async () => {
    const { db, batches } = fakeHttpDb([{ ...row, name: 'Renamed', brandColor: '#1D4ED8' }]);
    const updated = await createDrizzleStudioRepoHttp(db, claims).updateById(STUDIO_ID, {
      name: 'Renamed',
      brandColor: '#1D4ED8',
      brandLogo: 'ignored',
    });
    expect(updated).toMatchObject({ name: 'Renamed', brandColor: '#1D4ED8', brandLogo: null });
    expect(batches[0]?.kinds).toEqual(['execute', 'execute', 'execute', 'update']);
    expect(batches[0]?.set).toEqual({ name: 'Renamed', brandColor: '#1D4ED8' });
  });

  it('falls back to a scoped read when nothing editable changed', async () => {
    const { db, batches } = fakeHttpDb([row]);
    await createDrizzleStudioRepoHttp(db, claims).updateById(STUDIO_ID, { brandLogo: null });
    expect(batches[0]?.kinds).toEqual(['execute', 'execute', 'execute', 'select']);
  });

  it('returns null when RLS hides the row', async () => {
    const { db } = fakeHttpDb([]);
    await expect(createDrizzleStudioRepoHttp(db, claims).getById(STUDIO_ID)).resolves.toBeNull();
  });
});
