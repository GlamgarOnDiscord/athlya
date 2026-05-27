import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isCronDbUrlConfigured,
  logCronDbUrlMissing,
  resetCronDbUrlWarnedForTests,
  shouldRequireCronDbUrl,
} from '../maintenance/cron-db-config.js';

afterEach(() => {
  resetCronDbUrlWarnedForTests();
  vi.restoreAllMocks();
});

describe('shouldRequireCronDbUrl', () => {
  it('requires binding in staging and production', () => {
    expect(shouldRequireCronDbUrl('staging')).toBe(true);
    expect(shouldRequireCronDbUrl('production')).toBe(true);
  });

  it('does not require binding in dev', () => {
    expect(shouldRequireCronDbUrl('dev')).toBe(false);
    expect(shouldRequireCronDbUrl(undefined)).toBe(false);
  });
});

describe('isCronDbUrlConfigured', () => {
  it('rejects empty or whitespace URLs', () => {
    expect(isCronDbUrlConfigured(undefined)).toBe(false);
    expect(isCronDbUrlConfigured('')).toBe(false);
    expect(isCronDbUrlConfigured('   ')).toBe(false);
  });

  it('accepts non-empty connection strings', () => {
    expect(isCronDbUrlConfigured('postgresql://athlya_cron@host/db')).toBe(true);
  });
});

describe('logCronDbUrlMissing', () => {
  it('logs configuration_error once per isolate by default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logCronDbUrlMissing({ environment: 'production', cron: '0 3 * * *' });
    logCronDbUrlMissing({ environment: 'production', cron: '0 3 * * *' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      code: 'configuration_error',
      binding: 'CRON_DB_URL',
      event: 'rgpd_maintenance_cycle_skipped',
    });
  });
});
