/**
 * Issue #466 — per-endpoint rate limits on sensitive auth routes.
 *
 * Covers:
 *   1. fail-closed: Redis down → 503 on POST /v1/auth/login.
 *   2. fail-closed: Redis down → 503 on POST /v1/auth/register.
 *   3. fail-closed: Redis down → 503 on POST /v1/auth/password-reset/request.
 *   4. dev bypass: Redis down → not 503 on any auth endpoint in dev env.
 *   5. non-POST methods are not throttled by the per-endpoint limiter.
 *   6. enforcement: 429 + Retry-After when per-route budget is exceeded.
 *   7. per-route isolation: exceeding login budget does not block register.
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

  it('GET /v1/auth/turnstile-challenge skips the fail-closed auth bucket (#649)', async () => {
    const env = primeStagingDown();
    const app = buildAppNoDomainRoutes();

    const page = await app.request(
      '/v1/auth/turnstile-challenge',
      { method: 'GET', headers: stagingHeaders },
      env,
    );
    expect(page.status).not.toBe(503);

    const other = await app.request(
      '/v1/auth/turnstile-challenge-other',
      { method: 'GET', headers: stagingHeaders },
      env,
    );
    expect(other.status).toBe(503);

    const post = await app.request(
      '/v1/auth/turnstile-challenge',
      { method: 'POST', headers: stagingHeaders },
      env,
    );
    expect(post.status).toBe(503);
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

  it('enforces 429 + Retry-After once login budget (5/60s) is exhausted', async () => {
    // LOGIN_BUDGET = { ipLimit: 5, windowSec: 60 }. All six requests
    // arrive within the same window (FakeRedis.nowMs stays at 0).
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });
    const fakeRedis = new FakeRedis();
    __primeRateLimitRedisForTests(env.REDIS_URL, fakeRedis as unknown as Redis);
    const app = buildAppNoDomainRoutes();
    const headers = { ...stagingHeaders };

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/v1/auth/login', { method: 'POST', headers }, env);
      expect(res.status).not.toBe(429);
    }

    const res = await app.request('/v1/auth/login', { method: 'POST', headers }, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('login bucket is independent from register bucket (issue #466)', async () => {
    // Exhaust the login budget; register should still be reachable.
    const env = buildMockEnv({
      ENVIRONMENT: 'staging',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });
    const fakeRedis = new FakeRedis();
    __primeRateLimitRedisForTests(env.REDIS_URL, fakeRedis as unknown as Redis);
    const app = buildAppNoDomainRoutes();
    const headers = { ...stagingHeaders };

    // Exhaust login (5 requests)
    for (let i = 0; i < 5; i++) {
      await app.request('/v1/auth/login', { method: 'POST', headers }, env);
    }
    // 6th login is throttled
    const throttled = await app.request('/v1/auth/login', { method: 'POST', headers }, env);
    expect(throttled.status).toBe(429);

    // Register should still pass (its own fresh bucket with REGISTER_BUDGET = 10/60s)
    const reg = await app.request('/v1/auth/register', { method: 'POST', headers }, env);
    expect(reg.status).not.toBe(429);
  });
});
