import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { toProblemResponse } from '../middleware/problem-details.js';

vi.mock('@athlya/db/client', () => ({
  createDbHttp: (url: string) => ({ _url: url }),
  createDb: vi.fn(),
}));
vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor(public opts: unknown) {}
  },
}));

import {
  ChaosInjectedError,
  parseChaosRate,
  throwIfChaos,
  getOrCreateDbHttpForRegion,
  getOrCreateRedisForEnv,
  resetAllDepsCachesForTests,
} from '../adapters/deps-cache.js';

const PRIMARY_URL = 'postgresql://user:pass@ep-primary.us-east-2.aws.neon.tech/db';

beforeEach(() => {
  resetAllDepsCachesForTests();
});

describe('parseChaosRate', () => {
  it('returns undefined when absent', () => {
    expect(parseChaosRate({})).toBeUndefined();
  });

  it('returns undefined when empty string', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '' })).toBeUndefined();
  });

  it('returns undefined for NaN', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: 'foo' })).toBeUndefined();
  });

  it('returns undefined for zero', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '0' })).toBeUndefined();
  });

  it('returns undefined for negative value', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '-0.1' })).toBeUndefined();
  });

  it('returns the rate for a valid positive float', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '0.5' })).toBe(0.5);
  });

  it('returns 1 for rate above 1 (clamped)', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '2' })).toBe(1);
  });

  it('returns 1 for rate exactly 1', () => {
    expect(parseChaosRate({ CHAOS_NEON_FAILURE_RATE: '1' })).toBe(1);
  });
});

describe('throwIfChaos', () => {
  it('does not throw when rate is undefined', () => {
    expect(() => throwIfChaos(undefined)).not.toThrow();
  });

  it('never throws when rate is 0 (handled by parseChaosRate returning undefined)', () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(() => throwIfChaos(undefined)).not.toThrow();
    } finally {
      Math.random = originalRandom;
    }
  });

  it('always throws ChaosInjectedError when rate is 1', () => {
    expect(() => throwIfChaos(1)).toThrow(ChaosInjectedError);
  });

  it('throws when Math.random() < rate', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.3;
    try {
      expect(() => throwIfChaos(0.5)).toThrow(ChaosInjectedError);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('does not throw when Math.random() >= rate', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.7;
    try {
      expect(() => throwIfChaos(0.5)).not.toThrow();
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe('getOrCreateDbHttpForRegion with chaos', () => {
  it('throws ChaosInjectedError when CHAOS_NEON_FAILURE_RATE=1', () => {
    const env = { DB_URL: PRIMARY_URL, CHAOS_NEON_FAILURE_RATE: '1' };
    expect(() => getOrCreateDbHttpForRegion(env, undefined)).toThrow(ChaosInjectedError);
  });

  it('does not throw when CHAOS_NEON_FAILURE_RATE is absent', () => {
    const env = { DB_URL: PRIMARY_URL };
    expect(() => getOrCreateDbHttpForRegion(env, undefined)).not.toThrow();
  });

  it('does not throw when CHAOS_NEON_FAILURE_RATE=0', () => {
    const env = { DB_URL: PRIMARY_URL, CHAOS_NEON_FAILURE_RATE: '0' };
    expect(() => getOrCreateDbHttpForRegion(env, undefined)).not.toThrow();
  });
});

describe('getOrCreateRedisForEnv with chaos', () => {
  afterEach(() => {
    resetAllDepsCachesForTests();
  });

  it('throws ChaosInjectedError when CHAOS_NEON_FAILURE_RATE=1', () => {
    const env = {
      REDIS_URL: 'https://redis.example.com',
      REDIS_TOKEN: 'tok',
      CHAOS_NEON_FAILURE_RATE: '1',
    };
    expect(() => getOrCreateRedisForEnv(env)).toThrow(ChaosInjectedError);
  });

  it('returns Redis client when CHAOS_NEON_FAILURE_RATE is absent', () => {
    const env = { REDIS_URL: 'https://redis.example.com', REDIS_TOKEN: 'tok' };
    expect(() => getOrCreateRedisForEnv(env)).not.toThrow();
  });
});

describe('ChaosInjectedError shape', () => {
  it('has code chaos_injected and name ChaosInjectedError', () => {
    const err = new ChaosInjectedError();
    expect(err.code).toBe('chaos_injected');
    expect(err.name).toBe('ChaosInjectedError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('toProblemResponse — ChaosInjectedError maps to 503', () => {
  it('returns status 503 with code chaos_injected', () => {
    const ctx = {
      traceId: 'test-trace-id',
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    };
    const err = new ChaosInjectedError();
    const result = toProblemResponse(err, ctx);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('chaos_injected');
  });
});
