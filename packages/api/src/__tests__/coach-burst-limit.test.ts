/**
 * `POST /v1/coach/ask` burst limiter (Epic 21, coverage row `coach-ask`).
 *
 * The limiter is mounted in the coach router after jwtAuth and the
 * `ai-coach` flag check, so:
 *   1. a member with the flag on is limited per user (5/min);
 *   2. with the flag off the route answers 404 and no bucket is touched;
 *   3. a Redis outage fails closed with 503 for flag-on members only.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../middleware/auth.js';
import { MUTATION_BUDGETS } from '../middleware/rate-limit-policies.js';
import {
  __primeStudioRateLimitRedisForTests,
  __resetStudioRateLimitRedisCache,
} from '../middleware/studio-rate-limit.js';
import {
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
  MUTATION_USER_BUCKET_PREFIX,
} from '../middleware/rate-limit.js';
import { buildApp } from '../worker.js';

import { readJson } from './helpers/read-json.js';
import {
  buildLocalResolver,
  buildMockEnv,
  FakeRedis,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
} from './helpers/test-app.js';
import { buildStubDeps } from './routes/route-test-helpers.js';

import type { JwksKeyResolver } from '../middleware/auth.js';
import type { TestKeypair } from './helpers/test-app.js';
import type { Redis } from '@upstash/redis';

const joseHoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (joseHoisted.localResolver === null) {
          throw new Error('jose mock: local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

class RedisPipelineDownFake extends FakeRedis {
  override pipeline(): ReturnType<FakeRedis['pipeline']> {
    const base = super.pipeline();
    return {
      ...base,
      async exec<T extends unknown[]>(): Promise<T> {
        throw new Error('ECONNREFUSED');
      },
    };
  }
}

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANSWER = {
  advice: {
    summary: 'Steady.',
    recommendations: [{ title: 'Rest', detail: 'Take a day off.' }],
    caution: null,
  },
  quota: { limit: 10, remaining: 9, resetsAt: '2026-10-16T00:00:00.000Z' },
  generatedAt: '2026-10-15T14:30:00.000Z',
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
  __resetJwksCacheForTests();
  __resetRateLimitRedisCache();
  __resetStudioRateLimitRedisCache();
});

afterEach(() => {
  __resetRateLimitRedisCache();
  __resetStudioRateLimitRedisCache();
  vi.restoreAllMocks();
});

function stagingEnv(redis: FakeRedis) {
  const env = buildMockEnv({
    ENVIRONMENT: 'staging',
    CORS_ORIGIN: 'https://app.staging.athlya.app',
  });
  __primeRateLimitRedisForTests(env.REDIS_URL, redis as unknown as Redis);
  __primeStudioRateLimitRedisForTests(env.REDIS_URL, env.REDIS_TOKEN, redis as unknown as Redis);
  return env;
}

async function ask(app: ReturnType<typeof buildApp>, env: ReturnType<typeof stagingEnv>) {
  const token = await signTestJwt(
    kp.privateKey,
    { sub: USER, studio: TEST_STUDIO_ID, role: 'member' },
    { aud: 'athlya-api-staging', expSec: Math.floor(Date.now() / 1_000) + 600 },
  );
  return app.request(
    '/v1/coach/ask',
    {
      method: 'POST',
      headers: {
        host: 'staging.api.athlya.app',
        'CF-Connecting-IP': '7.7.7.7',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ question: 'How?' }),
    },
    env,
  );
}

function coachKeys(redis: FakeRedis): string[] {
  return [...redis.sets.keys()].filter((key) => key.includes('mutation-coach'));
}

describe('POST /v1/coach/ask burst limiter', () => {
  it('limits a flag-on member per user', async () => {
    const redis = new FakeRedis();
    const env = stagingEnv(redis);
    const deps = buildStubDeps({
      coach: {
        isEnabled: vi.fn(() => Promise.resolve(true)),
        ask: vi.fn(() => Promise.resolve(ANSWER)),
      },
    });
    const app = buildApp({ deps });

    for (let i = 0; i < MUTATION_BUDGETS.coach.userLimit; i++) {
      expect((await ask(app, env)).status).toBe(200);
    }
    const denied = await ask(app, env);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).not.toBeNull();
    expect(denied.headers.get('content-type')).toContain('application/problem+json');
    expect((await readJson<{ code: string }>(denied)).code).toBe('coach_rate_limited');
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
    expect(coachKeys(redis)).toEqual([`${MUTATION_USER_BUCKET_PREFIX}-coach:${USER}`]);
  });

  it('answers 404 with the flag off without touching a bucket', async () => {
    const redis = new FakeRedis();
    const env = stagingEnv(redis);
    const deps = buildStubDeps();
    const app = buildApp({ deps });

    for (let i = 0; i <= MUTATION_BUDGETS.coach.userLimit; i++) {
      const res = await ask(app, env);
      expect(res.status).toBe(404);
      expect((await readJson<{ code: string }>(res)).code).toBe('coach_disabled');
    }
    expect(coachKeys(redis)).toEqual([]);
    expect(deps.coach.ask).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when Redis is down', async () => {
    const env = stagingEnv(new RedisPipelineDownFake());
    const deps = buildStubDeps({
      coach: { isEnabled: vi.fn(() => Promise.resolve(true)) },
    });
    const res = await ask(buildApp({ deps }), env);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await readJson<{ code: string }>(res)).code).toBe('dependency_unavailable');
    expect(deps.coach.ask).not.toHaveBeenCalled();
  });
});
