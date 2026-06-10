import { describe, expect, it, beforeEach } from 'vitest';

import {
  dbHttpCache,
  dbHttpEuCache,
  getOrCreateDbHttp,
  getOrCreateDbHttpForRegion,
  resetAllDepsCachesForTests,
} from '../adapters/deps-cache.js';

// neon() validates URL format at construction — use valid Neon URL shapes.
const PRIMARY_URL = 'postgresql://user:pass@ep-primary.us-east-2.aws.neon.tech/db';
const EU_URL = 'postgresql://user:pass@ep-eu-replica.eu-central-1.aws.neon.tech/db';

beforeEach(() => {
  resetAllDepsCachesForTests();
});

describe('getOrCreateDbHttpForRegion', () => {
  it('returns primary handle when DB_URL_EU is absent', () => {
    const env = { DB_URL: PRIMARY_URL };
    const handle = getOrCreateDbHttpForRegion(env, 'EU');
    expect(dbHttpCache.has(PRIMARY_URL)).toBe(true);
    expect(dbHttpEuCache.size).toBe(0);
    expect(handle).toBe(getOrCreateDbHttp(PRIMARY_URL));
  });

  it('returns primary handle when DB_URL_EU is empty string', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: '' };
    getOrCreateDbHttpForRegion(env, 'EU');
    expect(dbHttpEuCache.size).toBe(0);
    expect(dbHttpCache.has(PRIMARY_URL)).toBe(true);
  });

  it('returns primary handle when continent is not EU', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    getOrCreateDbHttpForRegion(env, 'NA');
    expect(dbHttpEuCache.size).toBe(0);
    expect(dbHttpCache.has(PRIMARY_URL)).toBe(true);
  });

  it('returns primary handle when continent is undefined', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    getOrCreateDbHttpForRegion(env, undefined);
    expect(dbHttpEuCache.size).toBe(0);
    expect(dbHttpCache.has(PRIMARY_URL)).toBe(true);
  });

  it('returns EU replica handle when DB_URL_EU is set and continent is EU', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    const handle = getOrCreateDbHttpForRegion(env, 'EU');
    expect(dbHttpEuCache.has(EU_URL)).toBe(true);
    expect(dbHttpCache.size).toBe(0);
    expect(handle).toBe(getOrCreateDbHttpForRegion(env, 'EU'));
  });

  it('caches EU handle across calls (same object reference)', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    const first = getOrCreateDbHttpForRegion(env, 'EU');
    const second = getOrCreateDbHttpForRegion(env, 'EU');
    expect(first).toBe(second);
    expect(dbHttpEuCache.size).toBe(1);
  });

  it('keeps primary and EU caches independent (different URLs never alias)', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    const primary = getOrCreateDbHttpForRegion(env, 'NA');
    const eu = getOrCreateDbHttpForRegion(env, 'EU');
    expect(primary).not.toBe(eu);
    expect(dbHttpCache.size).toBe(1);
    expect(dbHttpEuCache.size).toBe(1);
  });

  it('resetAllDepsCachesForTests clears EU cache', () => {
    const env = { DB_URL: PRIMARY_URL, DB_URL_EU: EU_URL };
    getOrCreateDbHttpForRegion(env, 'EU');
    expect(dbHttpEuCache.size).toBe(1);
    resetAllDepsCachesForTests();
    expect(dbHttpEuCache.size).toBe(0);
  });
});
