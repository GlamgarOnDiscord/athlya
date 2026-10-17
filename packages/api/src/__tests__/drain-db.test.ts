import { describe, expect, it, vi } from 'vitest';

import { resolveDrainDbUrl, withDrainDb } from '../adapters/drain-db.js';

import type { AthlyaDb } from '@athlya/db/client';

/** Issue #609 — the per-tick postgres-js client is always closed. */
describe('withDrainDb', () => {
  function fakeDb(): { db: AthlyaDb; end: ReturnType<typeof vi.fn> } {
    const end = vi.fn<(options?: { timeout?: number }) => Promise<void>>().mockResolvedValue();
    return { db: { $client: { end } } as unknown as AthlyaDb, end };
  }

  it('closes the client after a successful drain', async () => {
    const { db, end } = fakeDb();

    await expect(
      withDrainDb(
        'postgres://x',
        () => Promise.resolve(7),
        () => db,
      ),
    ).resolves.toBe(7);
    expect(end).toHaveBeenCalledWith({ timeout: 1 });
  });

  it('closes the client when the drain throws, and rethrows', async () => {
    const { db, end } = fakeDb();

    await expect(
      withDrainDb(
        'postgres://x',
        () => Promise.reject(new Error('claim failed')),
        () => db,
      ),
    ).rejects.toThrow('claim failed');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('does not mask the drain result when closing fails', async () => {
    const { db, end } = fakeDb();
    end.mockRejectedValueOnce(new Error('socket gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      withDrainDb(
        'postgres://x',
        () => Promise.resolve('ok'),
        () => db,
      ),
    ).resolves.toBe('ok');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * Issue #497 — the scheduled drain runs as athlya_cron (CRON_DB_URL),
 * never as the tenant DB_URL role outside dev.
 */
describe('resolveDrainDbUrl', () => {
  it('uses CRON_DB_URL whenever it is configured', () => {
    expect(
      resolveDrainDbUrl({
        ENVIRONMENT: 'production',
        CRON_DB_URL: 'postgres://athlya_cron@db/athlya',
        DB_URL: 'postgres://athlya_app@db/athlya',
      }),
    ).toBe('postgres://athlya_cron@db/athlya');
  });

  it.each(['staging', 'production', 'preview'])(
    'refuses to fall back to DB_URL on %s',
    (environment) => {
      expect(
        resolveDrainDbUrl({ ENVIRONMENT: environment, DB_URL: 'postgres://athlya_app@db/athlya' }),
      ).toBeNull();
    },
  );

  it('treats a blank CRON_DB_URL as missing', () => {
    expect(resolveDrainDbUrl({ ENVIRONMENT: 'production', CRON_DB_URL: '  ' })).toBeNull();
  });

  it('falls back to DB_URL in dev', () => {
    expect(
      resolveDrainDbUrl({ ENVIRONMENT: 'dev', DB_URL: 'postgres://dev@localhost/athlya' }),
    ).toBe('postgres://dev@localhost/athlya');
  });
});
