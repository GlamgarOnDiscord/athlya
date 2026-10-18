/**
 * Rate limits of the check-in routes (issues #338, #654).
 *
 * `POST /v1/checkins` is the kiosk scan: the bucket is per operator
 * (admin or coach), and members are refused before it is touched.
 * `POST /v1/checkins/token` is per member.
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
import { CHECKIN_BUDGET, CHECKIN_TOKEN_BUDGET } from '../../middleware/rate-limit-policies.js';
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

const stagingEnv = () =>
  buildMockEnv({
    ENVIRONMENT: 'staging',
    JWT_AUDIENCE: 'athlya-api-dev',
    CORS_ORIGIN: 'https://app.staging.athlya.app',
  });

async function headersFor(role: 'member' | 'coach' | 'admin', userId = TEST_USER_ID) {
  const token = await signTestJwt(kp.privateKey, { sub: userId, studio: TEST_STUDIO_ID, role });
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    host: 'staging.api.athlya.app',
    'CF-Connecting-IP': '1.2.3.4',
  };
}

describe('POST /v1/checkins — per-operator rate limit (issues #338, #654)', () => {
  it('allows CHECKIN_BUDGET scans per minute for one operator, then 429 + Retry-After', async () => {
    const deps = buildStubDeps({
      checkins: {
        checkIn: vi.fn().mockResolvedValue({
          kind: 'success',
          reservationId: 'r1',
          member: { id: 'u1', displayName: 'Ada', avatarUrl: null },
        }),
        rateLimitOpts: { redis: new FakeRedis() as unknown as Redis },
      },
    });
    const app = buildApp({ deps });
    const env = stagingEnv();
    const headers = await headersFor('coach');
    const body = JSON.stringify({ qrToken: 'valid.qr.token' });
    const limit = CHECKIN_BUDGET.userLimit ?? 0;

    for (let i = 0; i < limit; i++) {
      const res = await app.request('/v1/checkins', { method: 'POST', headers, body }, env);
      expect(res.status, `scan ${String(i + 1)} should be allowed`).toBe(200);
    }

    const blocked = await app.request('/v1/checkins', { method: 'POST', headers, body }, env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();

    const otherOperator = await app.request(
      '/v1/checkins',
      {
        method: 'POST',
        headers: await headersFor('admin', '33333333-3333-4333-8333-333333333333'),
        body,
      },
      env,
    );
    expect(otherOperator.status).toBe(200);
  });

  it('answers 403 to a member before touching the bucket', async () => {
    const redis = new FakeRedis();
    const deps = buildStubDeps({
      checkins: { rateLimitOpts: { redis: redis as unknown as Redis } },
    });
    const res = await buildApp({ deps }).request(
      '/v1/checkins',
      { method: 'POST', headers: await headersFor('member'), body: '{"qrToken":"x"}' },
      stagingEnv(),
    );
    expect(res.status).toBe(403);
    expect([...redis.sets.keys()]).toEqual([]);
    expect(deps.checkins.checkIn).not.toHaveBeenCalled();
  });
});

describe('POST /v1/checkins/token — per-user rate limit (issue #654)', () => {
  it('allows CHECKIN_TOKEN_BUDGET tokens per minute, then 429', async () => {
    const deps = buildStubDeps({
      checkins: {
        issueToken: vi
          .fn()
          .mockResolvedValue({ token: 'a.b.c', expiresAt: '2026-10-18T10:02:00.000Z' }),
        rateLimitOpts: { redis: new FakeRedis() as unknown as Redis },
      },
    });
    const app = buildApp({ deps });
    const env = stagingEnv();
    const headers = await headersFor('member');
    const limit = CHECKIN_TOKEN_BUDGET.userLimit ?? 0;

    for (let i = 0; i < limit; i++) {
      const res = await app.request('/v1/checkins/token', { method: 'POST', headers }, env);
      expect(res.status).toBe(201);
    }
    const blocked = await app.request('/v1/checkins/token', { method: 'POST', headers }, env);
    expect(blocked.status).toBe(429);
  });
});
