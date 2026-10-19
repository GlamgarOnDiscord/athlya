/**
 * `GET /v1/me/progression/cardio` (issue #683).
 */

import { CardioProgressionResponseSchema } from '@athlya/shared/schemas/api';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { PROGRESSION_CACHE_CONTROL } from '../../routes/me.js';
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
import type { CardioProgressionResponse } from '@athlya/shared/schemas/api';

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

const CARDIO: CardioProgressionResponse = {
  windowDays: 30,
  from: '2026-09-16T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  bucket: 'week',
  totals: { sessions: 1, durationSec: 1_800, distanceM: 12_000, energyKcal: 350 },
  machines: [
    {
      machine: 'indoorBike',
      sessionCount: 1,
      totals: { durationSec: 1_800, distanceM: 12_000, energyKcal: 350 },
      series: [
        {
          periodStart: '2026-10-12',
          sessions: 1,
          durationSec: 1_800,
          distanceM: 12_000,
          energyKcal: 350,
          avgPowerW: 180,
          avgHeartRateBpm: 142,
        },
      ],
      points: [
        {
          startedAt: '2026-10-15T07:00:00.000Z',
          durationSec: 1_800,
          distanceM: 12_000,
          avgPowerW: 180,
          avgSpeedKmh: 24,
          avgHeartRateBpm: 142,
        },
      ],
    },
  ],
  truncated: false,
  skippedSessions: 0,
};

const PATH = '/v1/me/progression/cardio';

describe('GET /v1/me/progression/cardio', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(PATH, {}, env());
    expect(res.status).toBe(401);
    expect(deps.members.getCardioProgression).not.toHaveBeenCalled();
  });

  it('returns 422 for a window outside 30 / 90 / 365', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      `${PATH}?window=7`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
    expect(deps.members.getCardioProgression).not.toHaveBeenCalled();
  });

  it('returns 422 for a bucket other than day / week', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      `${PATH}?bucket=month`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
    expect(deps.members.getCardioProgression).not.toHaveBeenCalled();
  });

  it('rejects unknown query parameters', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      `${PATH}?window=30&userId=someone-else`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
    expect(deps.members.getCardioProgression).not.toHaveBeenCalled();
  });

  it('defaults to a 90-day weekly series and scopes the read to the caller', async () => {
    const getCardioProgression = vi.fn(async () => ({ ...CARDIO, windowDays: 90 as const }));
    const deps = buildStubDeps({ members: { getCardioProgression } });
    const res = await buildApp({ deps }).request(PATH, { headers: await auth() }, env());
    expect(res.status).toBe(200);
    expect(getCardioProgression).toHaveBeenCalledWith(
      TEST_USER_ID,
      90,
      'week',
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
    expect(deps.members.getProgression).not.toHaveBeenCalled();
  });

  it('passes the requested window and day bucket through', async () => {
    const getCardioProgression = vi.fn(async () => ({
      ...CARDIO,
      windowDays: 365 as const,
      bucket: 'day' as const,
    }));
    const deps = buildStubDeps({ members: { getCardioProgression } });
    const res = await buildApp({ deps }).request(
      `${PATH}?window=365&bucket=day`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(200);
    expect(getCardioProgression).toHaveBeenCalledWith(TEST_USER_ID, 365, 'day', expect.anything());
  });

  it('returns the series with private cache headers and an ETag', async () => {
    const deps = buildStubDeps({
      members: { getCardioProgression: vi.fn(async () => CARDIO) },
    });
    const res = await buildApp({ deps }).request(
      `${PATH}?window=30`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe(PROGRESSION_CACHE_CONTROL);
    expect(res.headers.get('vary')?.toLowerCase()).toContain('authorization');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);
    const body = await readJson<CardioProgressionResponse>(res);
    expect(CardioProgressionResponseSchema.parse(body)).toEqual(CARDIO);
  });

  it('answers 304 when If-None-Match matches the ETag', async () => {
    const deps = buildStubDeps({
      members: { getCardioProgression: vi.fn(async () => CARDIO) },
    });
    const app = buildApp({ deps });
    const first = await app.request(`${PATH}?window=30`, { headers: await auth() }, env());
    const etag = first.headers.get('etag') ?? '';
    const second = await app.request(
      `${PATH}?window=30`,
      { headers: { ...(await auth()), 'if-none-match': etag } },
      env(),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(await second.text()).toBe('');
  });
});
