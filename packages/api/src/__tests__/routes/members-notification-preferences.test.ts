/**
 * Unit tests for `GET` / `PUT /v1/members/me/notification-preferences`
 * (issue #762).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  buildLocalResolver,
  buildMockEnv,
  buildStubDeps,
  env,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';
import type { NotificationPreferences } from '@athlya/shared/schemas/api';

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mintJwt(role: 'member' | 'admin' = 'member'): Promise<string> {
  return signTestJwt(kp.privateKey, {
    sub: TEST_USER_ID,
    studio: TEST_STUDIO_ID,
    role,
  });
}

function buildAppWithDeps(deps: DomainDeps) {
  return buildApp({ deps });
}

const PREFS: NotificationPreferences = {
  reservationCreated: { email: false, push: true },
  reservationReminder: { push: true },
  reservationCancelled: { email: true, push: true },
  reservationPromoted: { email: true, push: false },
};

const PATH = '/v1/members/me/notification-preferences';

async function put(deps: DomainDeps, body: unknown) {
  return buildAppWithDeps(deps).request(
    PATH,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${await mintJwt()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    buildMockEnv(),
  );
}

describe('/v1/members/me/notification-preferences', () => {
  it('needs authentication', async () => {
    const deps = buildStubDeps();
    const res = await buildAppWithDeps(deps).request(PATH, { method: 'GET' }, env());
    expect(res.status).toBe(401);
    expect(deps.members.getNotificationPreferences).not.toHaveBeenCalled();
  });

  it('GET returns the toggles of the caller', async () => {
    const deps = buildStubDeps({
      members: { getNotificationPreferences: vi.fn(async () => PREFS) },
    });
    const res = await buildAppWithDeps(deps).request(
      PATH,
      { method: 'GET', headers: { authorization: `Bearer ${await mintJwt()}` } },
      buildMockEnv(),
    );
    expect(res.status).toBe(200);
    expect(await readJson<{ preferences: NotificationPreferences }>(res)).toEqual({
      preferences: PREFS,
    });
    expect(deps.members.getNotificationPreferences).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ studioId: TEST_STUDIO_ID }),
    );
  });

  it('GET answers 404 when the member row is gone', async () => {
    const deps = buildStubDeps({
      members: { getNotificationPreferences: vi.fn(async () => null) },
    });
    const res = await buildAppWithDeps(deps).request(
      PATH,
      { method: 'GET', headers: { authorization: `Bearer ${await mintJwt()}` } },
      buildMockEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('PUT replaces the toggles', async () => {
    const deps = buildStubDeps({
      members: { updateNotificationPreferences: vi.fn(async () => PREFS) },
    });
    const res = await put(deps, PREFS);
    expect(res.status).toBe(200);
    expect(deps.members.updateNotificationPreferences).toHaveBeenCalledWith(
      TEST_USER_ID,
      PREFS,
      expect.objectContaining({ userId: TEST_USER_ID }),
    );
  });

  it('PUT refuses to turn a mandatory message off', async () => {
    const deps = buildStubDeps();
    const res = await put(deps, { ...PREFS, passwordReset: { email: false } });
    expect(res.status).toBe(422);
    expect(deps.members.updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it('PUT refuses a partial set', async () => {
    const deps = buildStubDeps();
    const res = await put(deps, { reservationCreated: { email: false, push: true } });
    expect(res.status).toBe(422);
    expect(deps.members.updateNotificationPreferences).not.toHaveBeenCalled();
  });
});
