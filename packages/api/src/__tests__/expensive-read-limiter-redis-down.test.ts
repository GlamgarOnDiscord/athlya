/**
 * Issue #133 — expensive read + admin stats limiters fail-closed when Redis throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMIN_STATS_GET_PATHS } from '../middleware/rate-limit-policies.js';
import {
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
} from '../middleware/rate-limit.js';

import { readJson } from './helpers/read-json.js';
import { buildAppNoDomainRoutes, FakeRedis, buildMockEnv } from './helpers/test-app.js';

import type { Redis } from '@upstash/redis';

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

const stagingHeaders = { host: 'staging.api.athlya.app', 'CF-Connecting-IP': '9.9.9.9' };

describe('expensive read limiter Redis down (#133)', () => {
  beforeEach(() => {
    __resetRateLimitRedisCache();
  });

  afterEach(() => {
    __resetRateLimitRedisCache();
  });

  function primeDown(env: ReturnType<typeof buildMockEnv>) {
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);
  }

  it.each(ADMIN_STATS_GET_PATHS)(
    'staging GET %s → 503 fail-closed (dedicated admin limiter)',
    async (path) => {
      const env = buildMockEnv({
        ENVIRONMENT: 'staging',
        CORS_ORIGIN: 'https://app.staging.athlya.app',
      });
      primeDown(env);

      const app = buildAppNoDomainRoutes();
      const res = await app.request(path, { method: 'GET', headers: stagingHeaders }, env);

      expect(res.status).toBe(503);
      const body = await readJson<{ code?: string }>(res);
      expect(body.code).toBe('dependency_unavailable');
    },
  );

  it('staging GET /v1/members/me is not blocked by members-list limiter when Redis is up', async () => {
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });

    const app = buildAppNoDomainRoutes();
    const res = await app.request(
      '/v1/members/me',
      { method: 'GET', headers: stagingHeaders },
      env,
    );

    expect(res.status).not.toBe(503);
  });
});
