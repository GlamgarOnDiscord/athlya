import { describe, expect, it, vi } from 'vitest';

import {
  getOrCreateWriteDb,
  resetAllDepsCachesForTests,
  writeDbCache,
} from '../adapters/deps-cache.js';

import type { AthlyaBindings } from '../types.js';

vi.mock('@athlya/db/client', () => ({
  createDb: vi.fn((url: string, opts: { maxConnections?: number }) => ({
    url,
    maxConnections: opts.maxConnections,
  })),
  createDbHttp: vi.fn(),
}));

const { createDb } = await import('@athlya/db/client');

function baseEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return {
    ENVIRONMENT: 'staging',
    EVENTS_QUEUE: {} as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_DLQ: {} as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: 'postgres://direct/neondb',
    REDIS_URL: 'https://redis.example',
    REDIS_TOKEN: 'token',
    JWT_JWKS_URL: 'https://jwks.example',
    VERSION: 'test',
    ...overrides,
  };
}

describe('getOrCreateWriteDb', () => {
  it('creates a fresh direct client per call without Hyperdrive', () => {
    resetAllDepsCachesForTests();
    vi.mocked(createDb).mockClear();

    const env = baseEnv();
    const a = getOrCreateWriteDb(env);
    const b = getOrCreateWriteDb(env);

    expect(a).not.toBe(b);
    expect(createDb).toHaveBeenCalledTimes(2);
    expect(createDb).toHaveBeenCalledWith('postgres://direct/neondb', {
      maxConnections: 1,
      idleTimeoutSec: 5,
    });
    expect(writeDbCache.size).toBe(0);
  });

  it('caches one pooled client per isolate when Hyperdrive is bound', () => {
    resetAllDepsCachesForTests();
    vi.mocked(createDb).mockClear();

    const env = baseEnv({
      HYPERDRIVE: { connectionString: 'postgres://hyperdrive/pool' },
    });
    const a = getOrCreateWriteDb(env);
    const b = getOrCreateWriteDb(env);

    expect(a).toBe(b);
    expect(createDb).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith('postgres://hyperdrive/pool', {
      maxConnections: 3,
      idleTimeoutSec: 30,
    });
    expect(writeDbCache.size).toBe(1);
  });
});
