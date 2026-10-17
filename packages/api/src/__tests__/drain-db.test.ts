import { describe, expect, it } from 'vitest';

import { resolveDrainDbUrl } from '../adapters/drain-db.js';

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
