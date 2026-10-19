/**
 * Production wiring of the AI coach (`adapters/coach-deps.ts`, Epic 21).
 * No network: Redis is an in-memory fake and the model is never called.
 */

import { CoachError } from '@athlya/ai-coach/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCoachModelCacheForTests,
  AI_COACH_FLAG,
  buildCoachDeps,
  COACH_QUOTA_KEY_PREFIX,
  createRedisCoachQuotaStore,
  parseCoachDailyLimit,
  resolveCoachModel,
  resolveMistralBaseUrl,
} from '../adapters/coach-deps.js';
import { redisCache, resetAllDepsCachesForTests } from '../adapters/deps-cache.js';
import { defaultCoachDeps } from '../domain-deps.js';
import { __resetFeatureFlagCache, buildStaticFeatureFlagProvider } from '../feature-flags.js';

import { buildMockEnv } from './helpers/test-app.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { AthlyaBindings } from '../types.js';
import type { Redis } from '@upstash/redis';

const mistralHoisted = vi.hoisted(() => ({
  calls: [] as Array<{ apiKey?: string; baseURL?: string }>,
}));

vi.mock('@ai-sdk/mistral', () => ({
  createMistral: (settings: { apiKey?: string; baseURL?: string }) => {
    mistralHoisted.calls.push(settings);
    return (modelId: string) => ({ modelId, settings });
  },
}));

const CLAIMS: AuthClaims = {
  userId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab',
  studioId: '018f3c11-4e2d-7b53-9a0c-0000000000aa',
  role: 'member',
};

class CounterRedis {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  down = false;

  pipeline() {
    const ops: Array<() => number> = [];
    return {
      incr: (key: string) => {
        ops.push(() => {
          const next = (this.values.get(key) ?? 0) + 1;
          this.values.set(key, next);
          return next;
        });
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => {
          this.ttls.set(key, seconds);
          return 1;
        });
      },
      exec: <T extends unknown[]>(): Promise<T> =>
        this.down
          ? Promise.reject(new Error('ECONNREFUSED'))
          : Promise.resolve(ops.map((op) => op()) as T),
    };
  }

  get(key: string): Promise<string | null> {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED'));
    const value = this.values.get(key);
    return Promise.resolve(value === undefined ? null : String(value));
  }
}

function envWith(overrides: Partial<AthlyaBindings> = {}): {
  env: AthlyaBindings;
  redis: CounterRedis;
} {
  const env = buildMockEnv(overrides);
  const redis = new CounterRedis();
  redisCache.set(`${env.REDIS_URL}::${env.REDIS_TOKEN}`, redis as unknown as Redis);
  return { env, redis };
}

beforeEach(() => {
  resetAllDepsCachesForTests();
  __resetFeatureFlagCache();
  __resetCoachModelCacheForTests();
  mistralHoisted.calls.length = 0;
});

afterEach(() => {
  resetAllDepsCachesForTests();
  __resetFeatureFlagCache();
});

describe('parseCoachDailyLimit', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['0', undefined],
    ['-3', undefined],
    ['2.5', undefined],
    ['abc', undefined],
    ['25', 25],
    [' 7 ', 7],
  ])('%j → %j', (raw, expected) => {
    expect(parseCoachDailyLimit(raw)).toBe(expected);
  });
});

describe('createRedisCoachQuotaStore', () => {
  it('increments a per-user, per-day counter with a TTL and reads it back', async () => {
    const { env, redis } = envWith({ REDIS_KEY_PREFIX: 'pr-7:' });
    const store = createRedisCoachQuotaStore(env);
    const key = `pr-7:${COACH_QUOTA_KEY_PREFIX}:2026-10-15:${CLAIMS.userId}`;

    expect(await store.peek(CLAIMS.userId, '2026-10-15')).toBe(0);
    expect(await store.increment(CLAIMS.userId, '2026-10-15', 3600)).toBe(1);
    expect(await store.increment(CLAIMS.userId, '2026-10-15', 3500)).toBe(2);
    expect(await store.peek(CLAIMS.userId, '2026-10-15')).toBe(2);
    expect(redis.ttls.get(key)).toBe(3500);
    expect(await store.peek(CLAIMS.userId, '2026-10-16')).toBe(0);
  });

  it('propagates Redis failures so the use case fails closed', async () => {
    const { env, redis } = envWith();
    redis.down = true;
    const store = createRedisCoachQuotaStore(env);
    await expect(store.increment(CLAIMS.userId, '2026-10-15', 60)).rejects.toThrow();
    await expect(store.peek(CLAIMS.userId, '2026-10-15')).rejects.toThrow();
  });
});

describe('buildCoachDeps', () => {
  it('keeps the flag OFF by default', async () => {
    const { env } = envWith();
    expect(await buildCoachDeps(env).isEnabled(CLAIMS)).toBe(false);
  });

  it.each([
    '{not json',
    'null',
    '[]',
    '"ai-coach"',
    JSON.stringify({ [AI_COACH_FLAG]: 'yes' }),
    JSON.stringify({ [AI_COACH_FLAG]: null }),
    JSON.stringify({ [AI_COACH_FLAG]: { rollout: '100' } }),
    JSON.stringify({ [AI_COACH_FLAG]: { rollout: 100, allowList: 'everyone' } }),
    JSON.stringify({ [AI_COACH_FLAG]: { rollout: 0, studioAllowList: [1, 2] } }),
  ])('keeps the flag OFF on a malformed catalogue %s', async (json) => {
    __resetFeatureFlagCache();
    const { env } = envWith({ FEATURE_FLAGS_JSON: json });
    expect(await buildCoachDeps(env).isEnabled(CLAIMS)).toBe(false);
  });

  it('reads the ai-coach flag, including studio allow-lists', async () => {
    const on = envWith({ FEATURE_FLAGS_JSON: JSON.stringify({ [AI_COACH_FLAG]: true }) });
    expect(await buildCoachDeps(on.env).isEnabled(CLAIMS)).toBe(true);
    __resetFeatureFlagCache();

    const studio = envWith({
      FEATURE_FLAGS_JSON: JSON.stringify({
        [AI_COACH_FLAG]: { rollout: 0, studioAllowList: [CLAIMS.studioId] },
      }),
    });
    expect(await buildCoachDeps(studio.env).isEnabled(CLAIMS)).toBe(true);
    expect(
      await buildCoachDeps(studio.env).isEnabled({ ...CLAIMS, studioId: 'other-studio' }),
    ).toBe(false);
  });

  it('answers not_configured without MISTRAL_API_KEY, before any read', async () => {
    const { env, redis } = envWith({ MISTRAL_API_KEY: '' });
    const error = await buildCoachDeps(env)
      .ask(CLAIMS, { question: 'How?', locale: 'en' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).code).toBe('not_configured');
    expect(redis.values.size).toBe(0);
  });

  it('refuses the stream the same way, before it opens', async () => {
    const { env, redis } = envWith({ MISTRAL_API_KEY: '' });
    const error = await buildCoachDeps(env)
      .askStream(CLAIMS, { question: 'How?', locale: 'en' }, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).code).toBe('not_configured');
    expect(redis.values.size).toBe(0);
  });
});

describe('resolveMistralBaseUrl', () => {
  it.each([undefined, '', '   '])('falls back to the provider default for %j', (raw) => {
    expect(resolveMistralBaseUrl(raw)).toBeUndefined();
  });

  it('accepts an https mistral.ai endpoint and trims the trailing slash', () => {
    expect(resolveMistralBaseUrl('https://api.eu.mistral.ai/v1/')).toBe(
      'https://api.eu.mistral.ai/v1',
    );
  });

  it.each([
    'http://api.mistral.ai/v1',
    'https://evil.example/v1',
    'https://mistral.ai.evil.example/v1',
    'https://user:pass@api.mistral.ai/v1',
    'https://api.mistral.ai/v1?region=eu',
    'https://api.mistral.ai/v1#eu',
    'not a url',
  ])('rejects %s as not_configured', (raw) => {
    const error = (() => {
      try {
        resolveMistralBaseUrl(raw);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).code).toBe('not_configured');
  });
});

describe('resolveCoachModel', () => {
  it('passes MISTRAL_BASE_URL to createMistral and caches per endpoint', () => {
    const base = buildMockEnv({ MISTRAL_API_KEY: 'test-key' });
    resolveCoachModel(base);
    resolveCoachModel({ ...base, MISTRAL_BASE_URL: '' });
    expect(mistralHoisted.calls).toEqual([{ apiKey: 'test-key' }]);

    resolveCoachModel({ ...base, MISTRAL_BASE_URL: 'https://api.eu.mistral.ai/v1' });
    expect(mistralHoisted.calls).toEqual([
      { apiKey: 'test-key' },
      { apiKey: 'test-key', baseURL: 'https://api.eu.mistral.ai/v1' },
    ]);
    resolveCoachModel({ ...base, MISTRAL_BASE_URL: 'https://api.eu.mistral.ai/v1' });
    expect(mistralHoisted.calls).toHaveLength(2);
  });

  it('never builds a provider for a rejected endpoint', () => {
    const env = buildMockEnv({
      MISTRAL_API_KEY: 'test-key',
      MISTRAL_BASE_URL: 'https://evil.example/v1',
    });
    expect(() => resolveCoachModel(env)).toThrow(CoachError);
    expect(mistralHoisted.calls).toEqual([]);
  });
});

describe('static flag catalogue warnings', () => {
  it('names invalid entries once, when the catalogue is built', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = buildStaticFeatureFlagProvider(
      JSON.stringify({ [AI_COACH_FLAG]: { rollout: '10' }, other: true, broken: null }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${AI_COACH_FLAG}, broken`);
    expect(await provider.getFlag(AI_COACH_FLAG, {})).toBe(false);
    expect(await provider.getFlag('other', {})).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('defaultCoachDeps', () => {
  it('reports the flag OFF when DB or Redis is not configured', async () => {
    const env = buildMockEnv({
      REDIS_URL: '',
      FEATURE_FLAGS_JSON: JSON.stringify({ [AI_COACH_FLAG]: true }),
    });
    expect(await defaultCoachDeps(env).isEnabled(CLAIMS)).toBe(false);
  });
});
