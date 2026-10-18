import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const withTenantMock = vi.hoisted(() => vi.fn());

vi.mock('@athlya/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@athlya/db/client')>();
  return {
    ...actual,
    withTenant: withTenantMock,
  };
});

import {
  createDrizzleBookingRepo,
  createDrizzleCancelRepo,
} from '../../adapters/reservations-write-drizzle.js';

import type { SQL } from 'drizzle-orm';

const CLAIMS = {
  userId: '00000000-0000-4000-8000-000000000001',
  studioId: '00000000-0000-4000-8000-000000000002',
  role: 'member' as const,
};

const fakeDb = { __brand: 'AthlyaDb' } as never;

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function makeTx(rows: unknown[] = []) {
  return {
    select: vi.fn().mockReturnValue(makeSelectChain(rows)),
  };
}

beforeEach(() => {
  withTenantMock.mockReset();
  withTenantMock.mockImplementation(
    async (_db: unknown, _claims: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe('createDrizzleBookingRepo', () => {
  it('scopes findClass through withTenant', async () => {
    const repo = createDrizzleBookingRepo(fakeDb, CLAIMS);
    const result = await repo.findClass('00000000-0000-4000-8000-000000000099');
    expect(result).toBeNull();
    expect(withTenantMock).toHaveBeenCalledWith(fakeDb, CLAIMS, expect.any(Function));
  });

  it('scopes withTransaction through withTenant', async () => {
    const repo = createDrizzleBookingRepo(fakeDb, CLAIMS);
    await repo.withTransaction(async () => 'ok');
    expect(withTenantMock).toHaveBeenCalledWith(fakeDb, CLAIMS, expect.any(Function));
  });
});

describe('createDrizzleCancelRepo', () => {
  it('scopes withTransaction through withTenant', async () => {
    const repo = createDrizzleCancelRepo(fakeDb, CLAIMS);
    await repo.withTransaction(async () => 'ok');
    expect(withTenantMock).toHaveBeenCalledWith(fakeDb, CLAIMS, expect.any(Function));
  });
});

/**
 * Issue #117 — under member claims the other members' waitlist rows and
 * the locking class read are hidden by RLS, so these calls go through
 * the SECURITY DEFINER functions of migration 0040.
 */
describe('cross-member reads and writes use the 0040 functions', () => {
  const dialect = new PgDialect();
  const CLASS_ID = '00000000-0000-4000-8000-000000000099';

  function sqlTx(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx = {
      execute: vi.fn(async (query: SQL) => {
        calls.push(dialect.sqlToQuery(query));
        return rows;
      }),
    };
    return { tx, calls };
  }

  it('locks the class through reservation_lock_class_for_cancel', async () => {
    const { tx, calls } = sqlTx([{ starts_at: '2030-08-01T09:00:00.000Z' }]);
    const repo = createDrizzleCancelRepo(fakeDb, CLAIMS);
    await expect(repo.findClassForUpdate(tx, CLASS_ID)).resolves.toEqual({
      startsAt: new Date('2030-08-01T09:00:00.000Z'),
    });
    expect(calls[0]?.sql).toContain('reservation_lock_class_for_cancel(');
    expect(calls[0]?.sql).not.toMatch(/for update/iu);
    expect(calls[0]?.params).toEqual([CLASS_ID]);
  });

  it('maps a NULL start time to a missing class', async () => {
    const { tx } = sqlTx([{ starts_at: null }]);
    await expect(
      createDrizzleCancelRepo(fakeDb, CLAIMS).findClassForUpdate(tx, CLASS_ID),
    ).resolves.toBeNull();
  });

  it.each([
    [
      { outcome: 'promoted', reservation_id: 'r-2', user_id: 'u-2' },
      { outcome: 'promoted', reservation: { id: 'r-2', classId: CLASS_ID, userId: 'u-2' } },
    ],
    [{ outcome: 'no_waiter', reservation_id: null, user_id: null }, { outcome: 'no_waiter' }],
    [{ outcome: 'no_capacity', reservation_id: null, user_id: null }, { outcome: 'no_capacity' }],
  ])('maps the promotion row %o', async (row, expected) => {
    const { tx, calls } = sqlTx([row]);
    await expect(
      createDrizzleCancelRepo(fakeDb, CLAIMS).promoteOldestWaitlist(tx, CLASS_ID),
    ).resolves.toEqual(expected);
    expect(calls[0]?.sql).toContain('reservation_promote_oldest_waitlist(');
    expect(calls[0]?.params).toEqual([CLASS_ID]);
  });

  it('refuses an unexpected promotion outcome', async () => {
    const { tx } = sqlTx([]);
    await expect(
      createDrizzleCancelRepo(fakeDb, CLAIMS).promoteOldestWaitlist(tx, CLASS_ID),
    ).rejects.toThrow(/unexpected outcome/u);
  });

  it('counts the waitlist ahead through reservation_waitlist_ahead', async () => {
    const { tx, calls } = sqlTx([{ ahead: '2' }]);
    const reservation = {
      id: '00000000-0000-4000-8000-000000000042',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    };
    await expect(
      createDrizzleBookingRepo(fakeDb, CLAIMS).countWaitlistAhead(
        tx as never,
        CLASS_ID,
        reservation,
      ),
    ).resolves.toBe(2);
    expect(calls[0]?.sql).toContain('reservation_waitlist_ahead(');
    // The reservation id, not its timestamp: ties on created_at are
    // broken on id, as in promotion.
    expect(calls[0]?.params).toEqual([CLASS_ID, reservation.id]);
  });
});
