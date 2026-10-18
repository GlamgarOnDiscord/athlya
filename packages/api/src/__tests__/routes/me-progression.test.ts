/**
 * `GET /v1/me/progression` (issue #639, task 22.1).
 */

import { ProgressionResponseSchema } from '@athlya/shared/schemas/api';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { PROGRESSION_CACHE_CONTROL, ifNoneMatchHits } from '../../routes/me.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  buildLocalResolver,
  buildStubDeps,
  env,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { ProgressionResponse } from '@athlya/shared/schemas/api';

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

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function auth(): Promise<Record<string, string>> {
  const token = await signTestJwt(kp.privateKey, {
    sub: TEST_USER_ID,
    studio: TEST_STUDIO_ID,
    role: 'member',
  });
  return { authorization: `Bearer ${token}` };
}

const PROGRESSION: ProgressionResponse = {
  windowDays: 30,
  from: '2026-09-16T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  totals: { sessions: 1, volumeKg: 500 },
  exercises: [
    {
      key: 'back squat',
      name: 'Back squat',
      sessionCount: 1,
      totalVolumeKg: 500,
      bestEstimatedOneRepMaxKg: 116.7,
      points: [{ date: '2026-10-15', volumeKg: 500, estimatedOneRepMaxKg: 116.7 }],
    },
  ],
  weeklyFrequency: [{ weekStart: '2026-10-12', sessions: 1 }],
  truncated: false,
  skippedSessions: 0,
};

describe('GET /v1/me/progression', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request('/v1/me/progression', {}, env());
    expect(res.status).toBe(401);
    expect(deps.members.getProgression).not.toHaveBeenCalled();
  });

  it('returns 422 for a window outside 30 / 90 / 365', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/me/progression?window=7',
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
    expect(deps.members.getProgression).not.toHaveBeenCalled();
  });

  it('rejects unknown query parameters', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/me/progression?window=30&userId=someone-else',
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
  });

  it('defaults to a 90-day window and scopes the read to the caller', async () => {
    const getProgression = vi.fn(async () => ({ ...PROGRESSION, windowDays: 90 as const }));
    const deps = buildStubDeps({ members: { getProgression } });
    const res = await buildApp({ deps }).request(
      '/v1/me/progression',
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(200);
    expect(getProgression).toHaveBeenCalledWith(
      TEST_USER_ID,
      90,
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
  });

  it('returns the progression with private cache headers and an ETag', async () => {
    const getProgression = vi.fn(async () => PROGRESSION);
    const deps = buildStubDeps({ members: { getProgression } });
    const res = await buildApp({ deps }).request(
      '/v1/me/progression?window=30',
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(200);
    expect(getProgression).toHaveBeenCalledWith(TEST_USER_ID, 30, expect.anything());
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe(PROGRESSION_CACHE_CONTROL);
    expect(res.headers.get('vary')?.toLowerCase()).toContain('authorization');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);
    const body = await readJson<ProgressionResponse>(res);
    expect(ProgressionResponseSchema.parse(body)).toEqual(PROGRESSION);
  });

  it('answers 304 when If-None-Match matches the ETag', async () => {
    const deps = buildStubDeps({ members: { getProgression: vi.fn(async () => PROGRESSION) } });
    const app = buildApp({ deps });
    const first = await app.request(
      '/v1/me/progression?window=30',
      { headers: await auth() },
      env(),
    );
    const etag = first.headers.get('etag') ?? '';
    const second = await app.request(
      '/v1/me/progression?window=30',
      { headers: { ...(await auth()), 'if-none-match': `W/${etag}` } },
      env(),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(await second.text()).toBe('');
  });
});

describe('ifNoneMatchHits', () => {
  const etag = '"0123456789abcdef"';

  it('matches a strong, weak, listed or wildcard tag', () => {
    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits(' * ', etag)).toBe(true);
  });

  it('misses an absent or different tag', () => {
    expect(ifNoneMatchHits(undefined, etag)).toBe(false);
    expect(ifNoneMatchHits('"other"', etag)).toBe(false);
  });
});
