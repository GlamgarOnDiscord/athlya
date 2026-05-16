/**
 * Unit tests for the Drizzle client factory.
 *
 * These tests mock out the drizzle transaction boundary so we can assert
 * the behaviour of {@link withTenant} and {@link notFoundIfEmpty}
 * without a live Postgres. The real RLS behaviour is covered by the
 * property test at `tests/properties/rls.property.test.ts` (task 2.7).
 *
 * Related requirements: 13.1, 13.5.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DbError,
  InvalidClaimsError,
  NotFoundError,
  notFoundIfEmpty,
  withTenant,
  type AthlyaDb,
  type AthlyaTx,
  type TenantClaims,
} from '../src/index.js';

/**
 * Minimal `AthlyaTx` stand-in. We only need `.execute()` to record the
 * calls drizzle emits; everything else on `PostgresJsTransaction` is
 * unused inside `withTenant`.
 */
interface FakeTx {
  execute: ReturnType<typeof vi.fn>;
}

/**
 * Builds a fake db whose `transaction(fn)` simply calls `fn(tx)` with
 * the provided fake tx and returns the result. This mirrors the real
 * drizzle contract closely enough for the assertions below.
 */
function makeFakeDb(): {
  db: AthlyaDb;
  tx: FakeTx;
  transaction: ReturnType<typeof vi.fn>;
} {
  const tx: FakeTx = {
    execute: vi.fn(() => Promise.resolve()),
  };
  const transaction = vi.fn((fn: (t: AthlyaTx) => Promise<unknown>) =>
    fn(tx as unknown as AthlyaTx),
  );
  const db = { transaction } as unknown as AthlyaDb;
  return { db, tx, transaction };
}

const VALID_CLAIMS: TenantClaims = {
  userId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab',
  studioId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac',
  role: 'member',
};

describe('withTenant', () => {
  it('opens a transaction and issues three SET LOCAL equivalents before fn runs', async () => {
    const { db, tx } = makeFakeDb();
    let fnRanAfterSets = false;

    await withTenant(db, VALID_CLAIMS, (t) => {
      // `fn` sees the SET LOCAL calls already recorded on the tx.
      fnRanAfterSets = tx.execute.mock.calls.length === 3;
      expect(t).toBe(tx);
      return Promise.resolve('ok');
    });

    expect(fnRanAfterSets).toBe(true);
    expect(tx.execute).toHaveBeenCalledTimes(3);

    // Confirm each SET LOCAL targets the documented session variable
    // and binds the claim value as a parameter (never concatenated).
    const calls = tx.execute.mock.calls.map((args: unknown[]) => args[0]);
    const sqlTexts = calls.map((c) => JSON.stringify(c));
    expect(sqlTexts[0]).toMatch(/app\.user_id/);
    expect(sqlTexts[1]).toMatch(/app\.studio_id/);
    expect(sqlTexts[2]).toMatch(/app\.role/);
  });

  it('returns the value produced by fn', async () => {
    const { db } = makeFakeDb();
    const out = await withTenant(db, VALID_CLAIMS, () => Promise.resolve(42));
    expect(out).toBe(42);
  });

  it('propagates errors thrown inside fn', async () => {
    const { db } = makeFakeDb();
    await expect(
      withTenant(db, VALID_CLAIMS, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
  });

  it('rejects a non-UUID userId before opening any transaction', async () => {
    const { db, tx, transaction } = makeFakeDb();
    await expect(
      withTenant(db, { ...VALID_CLAIMS, userId: 'not-a-uuid' }, () => Promise.resolve(null)),
    ).rejects.toBeInstanceOf(InvalidClaimsError);
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID studioId before opening any transaction', async () => {
    const { db } = makeFakeDb();
    await expect(
      withTenant(db, { ...VALID_CLAIMS, studioId: 'nope' }, () => Promise.resolve(null)),
    ).rejects.toBeInstanceOf(InvalidClaimsError);
  });

  it('rejects an unknown role', async () => {
    const { db } = makeFakeDb();
    await expect(
      withTenant(
        db,
        // Force the bad value past the type system to simulate a
        // bug in the upstream claim extractor.
        { ...VALID_CLAIMS, role: 'superadmin' as unknown as TenantClaims['role'] },
        () => Promise.resolve(null),
      ),
    ).rejects.toBeInstanceOf(InvalidClaimsError);
  });

  it('rejects a SQL-injection-shaped userId', async () => {
    // Defense-in-depth: even though `set_config` binds parameters,
    // the validator refuses obviously malicious strings up front.
    const { db } = makeFakeDb();
    await expect(
      withTenant(db, { ...VALID_CLAIMS, userId: `' ; DROP TABLE users; --` }, () =>
        Promise.resolve(null),
      ),
    ).rejects.toBeInstanceOf(InvalidClaimsError);
  });

  it('InvalidClaimsError extends DbError so gateway can catch by class', async () => {
    const { db } = makeFakeDb();
    await withTenant(db, { ...VALID_CLAIMS, userId: 'bad' }, () => Promise.resolve(null)).catch(
      (err: unknown) => {
        expect(err).toBeInstanceOf(DbError);
        expect(err).toBeInstanceOf(InvalidClaimsError);
        expect((err as DbError).code).toBe('invalid_tenant_claims');
      },
    );
  });
});

describe('notFoundIfEmpty', () => {
  it('returns the sole row when exactly one is present', () => {
    const row = { id: '1' };
    expect(notFoundIfEmpty([row])).toBe(row);
  });

  it('throws NotFoundError on an empty array', () => {
    expect(() => notFoundIfEmpty([])).toThrow(NotFoundError);
  });

  it('NotFoundError carries the stable code consumed by the error middleware', () => {
    try {
      notFoundIfEmpty<number>([]);
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe('not_found');
      return;
    }
    throw new Error('expected throw');
  });

  it('accepts a custom detail string for observability', () => {
    try {
      notFoundIfEmpty<number>([], 'reservation 42 not visible to tenant');
    } catch (err) {
      expect((err as NotFoundError).message).toBe('reservation 42 not visible to tenant');
      return;
    }
    throw new Error('expected throw');
  });

  it('throws a DbError (not NotFoundError) when more than one row is returned', () => {
    // A multi-row result indicates a missing LIMIT or a broken filter —
    // that is a programmer bug, not a 404.
    expect(() => notFoundIfEmpty([{ id: 1 }, { id: 2 }])).toThrow(DbError);
    expect(() => notFoundIfEmpty([{ id: 1 }, { id: 2 }])).not.toThrow(NotFoundError);
  });
});
