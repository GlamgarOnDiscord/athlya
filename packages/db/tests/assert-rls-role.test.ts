/**
 * Unit tests for {@link assertRlsRole} (issue #461): the runtime role
 * must not bypass RLS, either through BYPASSRLS or as a superuser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  rows: [] as Array<{ name: string; bypass?: boolean; superuser?: boolean }>,
}));

vi.mock('@neondatabase/serverless', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  neon: () => () => Promise.resolve(hoisted.rows),
}));

const { assertRlsRole } = await import('../src/client.js');

const URL = 'postgresql://role@db.example/athlya';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertRlsRole', () => {
  it('accepts a role without BYPASSRLS or SUPERUSER', async () => {
    hoisted.rows = [{ name: 'athlya_app', bypass: false, superuser: false }];
    await expect(assertRlsRole(URL, 'production')).resolves.toBeUndefined();
  });

  it('rejects a BYPASSRLS role', async () => {
    hoisted.rows = [{ name: 'athlya_owner', bypass: true, superuser: false }];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/BYPASSRLS/);
  });

  it('rejects a superuser even when rolbypassrls is false', async () => {
    hoisted.rows = [{ name: 'neondb_owner', bypass: false, superuser: true }];
    await expect(assertRlsRole(URL, 'staging')).rejects.toThrow(/SUPERUSER/);
  });

  it('rejects when current_user is missing from pg_roles', async () => {
    hoisted.rows = [];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/could not resolve/);
  });

  it('fails closed when a role flag is missing from the row', async () => {
    hoisted.rows = [{ name: 'athlya_app', bypass: false }];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/SUPERUSER/);
    hoisted.rows = [{ name: 'athlya_app', superuser: false }];
    await expect(assertRlsRole(URL, 'production')).rejects.toThrow(/BYPASSRLS/);
  });

  it('runs the check when ENVIRONMENT is empty', async () => {
    hoisted.rows = [{ name: 'neondb_owner', bypass: false, superuser: true }];
    await expect(assertRlsRole(URL, '')).rejects.toThrow(/SUPERUSER/);
  });

  it('skips the check in dev', async () => {
    hoisted.rows = [{ name: 'neondb_owner', bypass: true, superuser: true }];
    await expect(assertRlsRole(URL, 'dev')).resolves.toBeUndefined();
  });
});
