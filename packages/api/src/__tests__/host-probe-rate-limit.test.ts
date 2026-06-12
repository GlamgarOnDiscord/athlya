/**
 * Issue #244 — host-probe rate limiting and 404 on host mismatch.
 *
 * Verifies:
 *   1. An unrecognised host returns 404 (not 421).
 *   2. After 100 probes from the same IP the 101st gets 429.
 *   3. Redis failure fails open (404, not crash).
 *   4. Dev environment bypasses rate-limiting entirely.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOST_PROBE_BUCKET_PREFIX,
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
} from '../middleware/rate-limit.js';

import { buildAppNoDomainRoutes, buildMockEnv, FakeRedis } from './helpers/test-app.js';

import type { Redis } from '@upstash/redis';

const stagingEnv = buildMockEnv({
  ENVIRONMENT: 'staging',
  CORS_ORIGIN: 'https://app.staging.athlya.app',
});

const probeHeaders = {
  host: 'nonexistent-slug.staging.api.athlya.app',
  'CF-Connecting-IP': '5.5.5.5',
};

describe('host-probe rate limiting (issue #244)', () => {
  beforeEach(() => {
    __resetRateLimitRedisCache();
  });

  afterEach(() => {
    __resetRateLimitRedisCache();
  });

  it('returns 404 (not 421) for an unrecognised host in staging', async () => {
    const fake = new FakeRedis();
    __primeRateLimitRedisForTests(stagingEnv.REDIS_URL, fake as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request('/health', { method: 'GET', headers: probeHeaders }, stagingEnv);

    expect(res.status).toBe(404);
  });

  it('returns 429 when the host-probe bucket is saturated', async () => {
    const fake = new FakeRedis();
    fake.nowMs = 1_000;

    // Pre-populate the sorted set with 100 timestamps so the very first probe
    // request sees the bucket as full and gets 429 immediately (no jitter).
    const probeKey = `${HOST_PROBE_BUCKET_PREFIX}:5.5.5.5`;
    for (let i = 0; i < 100; i++) {
      await fake.zadd(probeKey, { score: fake.nowMs + i, member: `req-${String(i)}` });
    }

    __primeRateLimitRedisForTests(stagingEnv.REDIS_URL, fake as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request('/health', { method: 'GET', headers: probeHeaders }, stagingEnv);

    expect(res.status).toBe(429);
  });

  it('fails open when Redis is unreachable for the host-probe check', async () => {
    class BrokenRedis extends FakeRedis {
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

    __primeRateLimitRedisForTests(stagingEnv.REDIS_URL, new BrokenRedis() as unknown as Redis);

    const app = buildAppNoDomainRoutes();
    const res = await app.request('/health', { method: 'GET', headers: probeHeaders }, stagingEnv);

    // Fail-open: request gets through to host-check → 404, not 503.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(503);
  });

  it('dev environment bypasses rate-limiting (no Redis call, no jitter)', async () => {
    const devEnv = buildMockEnv({ ENVIRONMENT: 'dev' });
    const app = buildAppNoDomainRoutes();
    const res = await app.request(
      '/health',
      { method: 'GET', headers: { host: 'evil.com', 'CF-Connecting-IP': '5.5.5.5' } },
      devEnv,
    );

    expect(res.status).toBe(404);
  });
});
