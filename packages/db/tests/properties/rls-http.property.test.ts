/**
 * Structural property tests for `withTenantHttp` — Property 7, HTTP path.
 *
 * **Why a structural test and not a real-DB RLS test?**
 *
 * `withTenantHttp` relies on `db.batch([...])` from the Neon HTTP driver
 * (`drizzle-orm/neon-http`). That batch API is Neon-specific and cannot
 * be exercised against a standard Docker Postgres or PGlite instance.
 * Full RLS-enforcement testing on the HTTP path therefore requires a
 * Neon-compatible HTTP endpoint, which CI does not provide.
 *
 * Instead these tests verify the structural contract: that `withTenantHttp`
 * builds the correct four-item batch (three `SET LOCAL app.*` statements
 * followed by the business query), that claim values appear verbatim in
 * those statements, and that malformed claims are rejected before any DB
 * call is made. Combined with property test P7 (rls.property.test.ts),
 * which proves RLS isolation holds when the three session vars are set,
 * the structural test closes the gap: if the vars are always set before the
 * query, and the DB enforces isolation whenever they are set, then the HTTP
 * path is safe.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { InvalidClaimsError, withTenantHttp } from '../../src/index.js';

import type { AthlyaDbHttp, TenantClaims, TenantRole } from '../../src/client.js';

const UUID_ARB = fc.uuid({ version: 4 });
const ROLE_ARB: fc.Arbitrary<TenantRole> = fc.constantFrom('member', 'coach', 'admin');

const validClaimsArb: fc.Arbitrary<TenantClaims> = fc.record({
  userId: UUID_ARB,
  studioId: UUID_ARB,
  role: ROLE_ARB,
});

function buildMockDb(): {
  db: AthlyaDbHttp;
  batchSpy: ReturnType<typeof vi.fn>;
  executeSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn((rawSql: unknown) => ({ _rawSql: rawSql, _: { result: [] } }));
  const batchSpy = vi.fn(() => Promise.resolve([{}, {}, {}, []]));

  const db = {
    execute: executeSpy,
    batch: batchSpy,
  } as unknown as AthlyaDbHttp;

  return { db, batchSpy, executeSpy };
}

describe('withTenantHttp — batch structure (Property 7, HTTP path)', () => {
  it('calls batch() exactly once with 4 items for any valid claims', async () => {
    await fc.assert(
      fc.asyncProperty(validClaimsArb, async (claims) => {
        const { db, batchSpy } = buildMockDb();
        const mockQuery = { _: { result: [] } } as unknown as Parameters<typeof withTenantHttp>[2];

        await withTenantHttp(db, claims, mockQuery);

        expect(batchSpy).toHaveBeenCalledTimes(1);
        const [batchArg] = batchSpy.mock.calls[0] as [unknown[]];
        expect(batchArg).toHaveLength(4);
        expect(batchArg[3]).toBe(mockQuery);
      }),
      { numRuns: 25 },
    );
  });

  it('passes all three SET LOCAL values to execute() in the correct order', async () => {
    await fc.assert(
      fc.asyncProperty(validClaimsArb, async (claims) => {
        const { db, executeSpy } = buildMockDb();
        const mockQuery = { _: { result: [] } } as unknown as Parameters<typeof withTenantHttp>[2];

        await withTenantHttp(db, claims, mockQuery);

        expect(executeSpy).toHaveBeenCalledTimes(3);
        const calls = executeSpy.mock.calls as [{ queryChunks: unknown[] }][];

        const toSqlString = (arg: unknown): string => JSON.stringify(arg);
        const call0 = toSqlString(calls[0]?.[0]);
        const call1 = toSqlString(calls[1]?.[0]);
        const call2 = toSqlString(calls[2]?.[0]);

        expect(call0).toContain('app.user_id');
        expect(call0).toContain(claims.userId);
        expect(call1).toContain('app.studio_id');
        expect(call1).toContain(claims.studioId);
        expect(call2).toContain('app.role');
        expect(call2).toContain(claims.role);
      }),
      { numRuns: 25 },
    );
  });

  it('throws InvalidClaimsError for a non-UUID userId — no batch call made', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ studioId: UUID_ARB, role: ROLE_ARB }),
        fc
          .string()
          .filter(
            (s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
          ),
        async (partial, badUserId) => {
          const { db, batchSpy } = buildMockDb();
          const mockQuery = { _: { result: [] } } as unknown as Parameters<
            typeof withTenantHttp
          >[2];

          await expect(
            withTenantHttp(db, { ...partial, userId: badUserId }, mockQuery),
          ).rejects.toBeInstanceOf(InvalidClaimsError);

          expect(batchSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('throws InvalidClaimsError for an invalid role — no batch call made', async () => {
    const { db, batchSpy } = buildMockDb();
    const mockQuery = { _: { result: [] } } as unknown as Parameters<typeof withTenantHttp>[2];

    await expect(
      withTenantHttp(
        db,
        {
          userId: '11111111-1111-4111-8111-111111111111',
          studioId: '22222222-2222-4222-8222-222222222222',
          role: 'superadmin' as TenantRole,
        },
        mockQuery,
      ),
    ).rejects.toBeInstanceOf(InvalidClaimsError);

    expect(batchSpy).not.toHaveBeenCalled();
  });
});
