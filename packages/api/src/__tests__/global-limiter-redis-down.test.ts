/**
 * Issue #271 — global `/v1/*` limiter is fail-closed-soft when Redis throws:
 * returns 429 rate_limit_dependency_unavailable instead of passing through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
} from '../middleware/rate-limit.js';

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

describe('global limiter Redis down (#271)', () => {
  const stagingHeaders = { host: 'staging.api.athlya.app', 'CF-Connecting-IP': '9.9.9.9' };

  beforeEach(() => {
    __resetRateLimitRedisCache();
  });

  afterEach(() => {
    __resetRateLimitRedisCache();
  });

  it('staging GET /v1/* returns 429 (fail-closed-soft) when Redis pipeline throws', async () => {
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request(
      '/v1/unknown-route',
      { method: 'GET', headers: stagingHeaders },
      env,
    );

    expect(res.status).toBe(429);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('rate_limit_dependency_unavailable');
  });

  it('staging GET /health is not blocked by the global limiter', async () => {
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request(
      '/health',
      { method: 'GET', headers: { host: 'staging.api.athlya.app' } },
      env,
    );

    expect(res.status).toBe(200);
  });

  it('dev bypass keeps /v1/* reachable when Redis pipeline throws', async () => {
    const env = buildMockEnv({ ENVIRONMENT: 'dev' });
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request(
      '/v1/unknown-route',
      { method: 'GET', headers: { 'CF-Connecting-IP': '9.9.9.9', host: 'localhost' } },
      env,
    );

    expect(res.status).toBe(404);
  });
});
