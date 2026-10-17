/**
 * Unit tests for {@link assertRlsRole}: the per-isolate boot guard that
 * refuses a DB connection able to bypass RLS (issue #461). The Neon HTTP
 * driver is mocked so each case controls the `pg_roles` row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roleRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@neondatabase/serverless', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    neon: vi.fn(() => () => Promise.resolve(roleRows.value)),
  };
});

const { assertRlsRole } = await import('../src/client.js');

const URL = 'postgres://athlya_app:secret@db.example.test/neondb';

describe('assertRlsRole', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a role that is neither superuser nor BYPASSRLS', async () => {
    roleRows.value = [{ name: 'athlya_app', bypass: false, superuser: false }];
    await expect(assertRlsRole(URL, 'preview')).resolves.toBeUndefined();
  });

  it('rejects a BYPASSRLS role', async () => {
    roleRows.value = [{ name: 'neondb_owner', bypass: true, superuser: false }];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/has BYPASSRLS/u);
  });

  it('rejects a superuser even when rolbypassrls is false', async () => {
    roleRows.value = [{ name: 'postgres', bypass: false, superuser: true }];
    await expect(assertRlsRole(URL, 'staging')).rejects.toThrow(/has SUPERUSER/u);
  });

  it('fails closed when a role flag is missing from the row', async () => {
    roleRows.value = [{ name: 'athlya_app', bypass: false }];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/assertRlsRole/u);
  });

  it('fails closed when current_user cannot be resolved', async () => {
    roleRows.value = [];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/could not resolve/u);
  });

  it('runs the check when ENVIRONMENT is empty', async () => {
    roleRows.value = [{ name: 'postgres', bypass: false, superuser: true }];
    await expect(assertRlsRole(URL, '')).rejects.toThrow(/SUPERUSER/u);
  });

  it('skips the check in local environments', async () => {
    roleRows.value = [{ name: 'postgres', bypass: true, superuser: true }];
    await expect(assertRlsRole(URL, 'dev')).resolves.toBeUndefined();
  });
});
