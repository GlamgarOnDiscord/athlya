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

const CLAIMS = {
  userId: '00000000-0000-4000-8000-000000000001',
  studioId: '00000000-0000-4000-8000-000000000002',
  role: 'member' as const,
};

const fakeDb = { __brand: 'AthlyaDb' } as never;

beforeEach(() => {
  withTenantMock.mockReset();
  withTenantMock.mockImplementation(
    async (_db: unknown, _claims: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __brand: 'tx' }),
  );
});

describe('createDrizzleBookingRepo', () => {
  it('scopes findClass through withTenant', async () => {
    const repo = createDrizzleBookingRepo(fakeDb, CLAIMS);
    await expect(repo.findClass('00000000-0000-4000-8000-000000000099')).rejects.toThrow();
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
