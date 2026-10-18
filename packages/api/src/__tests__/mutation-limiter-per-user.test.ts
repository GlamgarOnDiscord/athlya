/**
 * Issue #613 — per-user mutation budgets.
 *
 * The mutation overlays in `base-app.ts` are registered before the
 * domain routers, so they authenticate inline before consuming a
 * bucket. Covers:
 *   1. Two users behind one IP get independent budgets.
 *   2. One user across two IPs shares a budget.
 *   3. Unauthenticated requests get 401 and never touch a mutation bucket.
 *   4. Mutation scopes do not share a sliding window per user.
 *   5. Fail-closed 503 on Redis outage still applies after auth.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MUTATION_BUDGETS } from '../middleware/rate-limit-policies.js';
import {
  __primeRateLimitRedisForTests,
  __resetRateLimitRedisCache,
  MUTATION_IP_BUCKET_PREFIX,
  MUTATION_USER_BUCKET_PREFIX,
} from '../middleware/rate-limit.js';

import { readJson } from './helpers/read-json.js';
import {
  buildAppNoDomainRoutes,
  buildLocalResolver,
  buildMockEnv,
  FakeRedis,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
} from './helpers/test-app.js';

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

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFILE_LIMIT = MUTATION_BUDGETS.profile.userLimit;

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

function stagingEnv() {
  return buildMockEnv({
    ENVIRONMENT: 'staging',
    CORS_ORIGIN: 'https://app.staging.athlya.app',
  });
}

function primeRedis(env: ReturnType<typeof buildMockEnv>, redis: FakeRedis): void {
  __primeRateLimitRedisForTests(env.REDIS_URL, redis as unknown as Redis);
}

async function tokenFor(userId: string): Promise<string> {
  return signTestJwt(
    kp.privateKey,
    { sub: userId, studio: TEST_STUDIO_ID, role: 'member' },
    { aud: 'athlya-api-staging', expSec: Math.floor(Date.now() / 1_000) + 600 },
  );
}

function headersFor(ip: string, token?: string): Record<string, string> {
  return {
    host: 'staging.api.athlya.app',
    'CF-Connecting-IP': ip,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

function mutationKeys(redis: FakeRedis): string[] {
  return [...redis.sets.keys()].filter(
    (key) =>
      key.startsWith(MUTATION_USER_BUCKET_PREFIX) || key.startsWith(MUTATION_IP_BUCKET_PREFIX),
  );
}

describe('per-user mutation limiters (#613)', () => {
  beforeEach(() => {
    __resetRateLimitRedisCache();
  });

  afterEach(() => {
    __resetRateLimitRedisCache();
  });

  it('gives two users behind one IP independent budgets', async () => {
    const env = stagingEnv();
    const redis = new FakeRedis();
    primeRedis(env, redis);
    const app = buildAppNoDomainRoutes();
    const tokenA = await tokenFor(USER_A);
    const tokenB = await tokenFor(USER_B);

    for (let i = 0; i < PROFILE_LIMIT; i++) {
      const res = await app.request(
        '/v1/me',
        { method: 'PATCH', headers: headersFor('9.9.9.9', tokenA) },
        env,
      );
      expect(res.status).not.toBe(429);
    }
    const deniedA = await app.request(
      '/v1/me',
      { method: 'PATCH', headers: headersFor('9.9.9.9', tokenA) },
      env,
    );
    expect(deniedA.status).toBe(429);
    expect(deniedA.headers.get('retry-after')).not.toBeNull();
    expect(deniedA.headers.get('x-content-type-options')).toBe('nosniff');

    const resB = await app.request(
      '/v1/me',
      { method: 'PATCH', headers: headersFor('9.9.9.9', tokenB) },
      env,
    );
    expect(resB.status).not.toBe(429);

    expect(mutationKeys(redis).sort()).toEqual([
      `${MUTATION_USER_BUCKET_PREFIX}-profile:${USER_A}`,
      `${MUTATION_USER_BUCKET_PREFIX}-profile:${USER_B}`,
    ]);
  });

  it('shares one budget for a user across two IPs', async () => {
    const env = stagingEnv();
    const redis = new FakeRedis();
    primeRedis(env, redis);
    const app = buildAppNoDomainRoutes();
    const tokenA = await tokenFor(USER_A);

    for (let i = 0; i < PROFILE_LIMIT; i++) {
      const ip = i % 2 === 0 ? '1.1.1.1' : '2.2.2.2';
      const res = await app.request(
        '/v1/me/consents',
        { method: 'PATCH', headers: headersFor(ip, tokenA) },
        env,
      );
      expect(res.status).not.toBe(429);
    }

    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      const denied = await app.request(
        '/v1/me',
        { method: 'PATCH', headers: headersFor(ip, tokenA) },
        env,
      );
      expect(denied.status).toBe(429);
    }
  });

  it.each([
    ['PATCH', '/v1/me'],
    ['PATCH', '/v1/me/consents'],
    ['POST', '/v1/reservations'],
    ['DELETE', '/v1/reservations/r-1'],
    ['POST', '/v1/members/me/export'],
  ] as const)(
    'unauthenticated %s %s → 401 without touching a mutation bucket',
    async (method, path) => {
      const env = stagingEnv();
      const redis = new FakeRedis();
      primeRedis(env, redis);
      const app = buildAppNoDomainRoutes();

      const missing = await app.request(path, { method, headers: headersFor('3.3.3.3') }, env);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await readJson<{ title?: string }>(missing);
      expect(body.title).toBe('missing_authorization');

      const invalid = await app.request(
        path,
        { method, headers: headersFor('3.3.3.3', 'not-a-jwt') },
        env,
      );
      expect(invalid.status).toBe(401);

      expect(mutationKeys(redis)).toEqual([]);
    },
  );

  it('keeps each mutation scope in its own per-user window', async () => {
    const env = stagingEnv();
    const redis = new FakeRedis();
    primeRedis(env, redis);
    const app = buildAppNoDomainRoutes();
    const tokenA = await tokenFor(USER_A);

    const firstExport = await app.request(
      '/v1/members/me/export',
      { method: 'POST', headers: headersFor('4.4.4.4', tokenA) },
      env,
    );
    expect(firstExport.status).not.toBe(429);
    const secondExport = await app.request(
      '/v1/members/me/export',
      { method: 'POST', headers: headersFor('4.4.4.4', tokenA) },
      env,
    );
    expect(secondExport.status).toBe(429);

    const profile = await app.request(
      '/v1/me',
      { method: 'PATCH', headers: headersFor('4.4.4.4', tokenA) },
      env,
    );
    expect(profile.status).not.toBe(429);
    const booking = await app.request(
      '/v1/reservations',
      { method: 'POST', headers: headersFor('4.4.4.4', tokenA) },
      env,
    );
    expect(booking.status).not.toBe(429);
  });

  it('does not authenticate or throttle non-mutation methods', async () => {
    const env = stagingEnv();
    const redis = new FakeRedis();
    primeRedis(env, redis);
    const app = buildAppNoDomainRoutes();

    const res = await app.request(
      '/v1/reservations',
      { method: 'GET', headers: headersFor('5.5.5.5') },
      env,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    expect(mutationKeys(redis)).toEqual([]);
  });

  it('stays fail-closed (503) for an authenticated mutation when Redis is down', async () => {
    const env = stagingEnv();
    primeRedis(env, new RedisPipelineDownFake());
    const app = buildAppNoDomainRoutes();
    const tokenA = await tokenFor(USER_A);

    const res = await app.request(
      '/v1/reservations',
      { method: 'POST', headers: headersFor('6.6.6.6', tokenA) },
      env,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('dependency_unavailable');

    const anonymous = await app.request(
      '/v1/reservations',
      { method: 'POST', headers: headersFor('6.6.6.6') },
      env,
    );
    expect(anonymous.status).toBe(401);
  });
});
