/**
 * Issue #338 — per-user rate limit on POST /v1/checkins.
 *
 * A member cannot physically attend more than 5 classes per hour.
 * The 6th check-in attempt within the window returns 429 with Retry-After.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import {
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
} from '../../middleware/rate-limit.js';
import {
  __primeStudioRateLimitRedisForTests,
  __resetStudioRateLimitRedisCache,
} from '../../middleware/studio-rate-limit.js';
import { buildApp } from '../../worker.js';

import {
  FakeRedis,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from '../helpers/test-app.js';

import { buildStubDeps } from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
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
          throw new Error('local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

const TEST_REDIS_URL = 'https://test.upstash.invalid';
const TEST_REDIS_TOKEN = 'h4-test-token';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
  __resetRateLimitRedisCache();
  __resetStudioRateLimitRedisCache();
  // Prime both rate limiters with permissive FakeRedis instances so requests
  // don't hang on DNS resolution to test.upstash.invalid in staging mode.
  __primeRateLimitRedisForTests(TEST_REDIS_URL, new FakeRedis() as unknown as Redis);
  __primeStudioRateLimitRedisForTests(
    TEST_REDIS_URL,
    TEST_REDIS_TOKEN,
    new FakeRedis() as unknown as Redis,
  );
});

afterEach(() => {
  __resetRateLimitRedisCache();
  __resetStudioRateLimitRedisCache();
  vi.restoreAllMocks();
});

describe('POST /v1/checkins — per-user rate limit (issue #338)', () => {
  it('allows 5 check-ins per hour then blocks the 6th with 429 + Retry-After', async () => {
    const fakeRedis = new FakeRedis() as unknown as Redis;

    const deps = buildStubDeps({
      checkins: {
        checkIn: vi.fn().mockResolvedValue({
          kind: 'success',
          reservation: { id: 'r1' },
          member: { id: 'u1' },
        }),
        rateLimitOpts: { redis: fakeRedis },
      },
    });
    const app = buildApp({ deps });

    const stagingEnv = buildMockEnv({
      ENVIRONMENT: 'staging',
      JWT_AUDIENCE: 'athlya-api-dev',
      CORS_ORIGIN: 'https://app.staging.athlya.app',
    });

    const token = await signTestJwt(kp.privateKey, {
      sub: TEST_USER_ID,
      studio: TEST_STUDIO_ID,
      role: 'member',
    });

    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      host: 'staging.api.athlya.app',
      'CF-Connecting-IP': '1.2.3.4',
    };
    const body = JSON.stringify({ qrToken: 'valid.qr.token' });

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/v1/checkins', { method: 'POST', headers, body }, stagingEnv);
      expect(res.status, `request ${String(i + 1)} should be allowed`).not.toBe(429);
    }

    const blocked = await app.request(
      '/v1/checkins',
      { method: 'POST', headers, body },
      stagingEnv,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
  });
});
