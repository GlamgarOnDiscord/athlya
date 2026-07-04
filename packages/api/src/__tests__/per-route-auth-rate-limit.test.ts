/**
 * Issue #466 — per-endpoint rate limits on sensitive auth routes.
 *
 * Covers:
 *   1. fail-closed: Redis down → 503 on POST /v1/auth/login.
 *   2. fail-closed: Redis down → 503 on POST /v1/auth/register.
 *   3. fail-closed: Redis down → 503 on POST /v1/auth/password-reset/request.
 *   4. dev bypass: Redis down → not 503 on any auth endpoint in dev env.
 *   5. non-POST methods are not throttled by the per-endpoint limiter.
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

const stagingHeaders = { host: 'staging.api.athlya.app', 'CF-Connecting-IP': '9.9.9.9' };

describe('per-route auth rate limits (#466)', () => {
  beforeEach(() => {
    __resetRateLimitRedisCache();
  });

  afterEach(() => {
    __resetRateLimitRedisCache();
  });

  function primeStagingDown() {
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);
    return env;
  }

  it.each([
    ['POST', '/v1/auth/login'],
    ['POST', '/v1/auth/register'],
    ['POST', '/v1/auth/password-reset/request'],
  ] as const)(
    'staging %s %s → 503 fail-closed when Redis is down (issue #466)',
    async (method, path) => {
      const env = primeStagingDown();
      const app = buildAppNoDomainRoutes();

      const res = await app.request(path, { method, headers: stagingHeaders }, env);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect((body as { code?: string }).code).toBe('dependency_unavailable');
    },
  );

  it('dev bypass keeps auth endpoints reachable when Redis is down', async () => {
    const env = buildMockEnv({ ENVIRONMENT: 'dev' });
    __primeRateLimitRedisForTests(env.REDIS_URL, new RedisPipelineDownFake() as unknown as Redis);
    const app = buildAppNoDomainRoutes();

    for (const path of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/password-reset/request']) {
      const res = await app.request(
        path,
        { method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9', host: 'localhost' } },
        env,
      );
      expect(res.status).not.toBe(503);
    }
  });

  it('OPTIONS on /v1/auth/login is not blocked by per-endpoint limiter', async () => {
    const env = primeStagingDown();
    const app = buildAppNoDomainRoutes();

    const res = await app.request(
      '/v1/auth/login',
      { method: 'OPTIONS', headers: stagingHeaders },
      env,
    );
    expect(res.status).not.toBe(503);
  });
});
