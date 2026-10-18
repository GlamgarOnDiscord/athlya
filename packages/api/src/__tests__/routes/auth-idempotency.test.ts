/**
 * `/v1/auth/*` with the idempotency middleware wired (issues #230, #645).
 *
 * Public routes (login, register) have no authenticated user: an
 * `Idempotency-Key` header there passes through and no store is built.
 * The authenticated route (DELETE /me) builds its store per request from
 * the caller's claims, so the owner-only RLS policies of
 * `idempotency_keys` see the caller, and replays the cached response.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { AthlyaDb } from '@athlya/db/client';

const hoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
  lookup: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@athlya/db/idempotency', () => ({
  lookup: hoisted.lookup,
  store: hoisted.store,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (hoisted.localResolver === null) {
          throw new Error('local resolver not initialised');
        }
        return hoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const SESSION = {
  accessToken: 'a.t',
  refreshToken: 'r.t',
  accessTokenExpiresIn: 900,
  refreshTokenExpiresIn: 2_592_000,
  user: { id: 'u1' },
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  hoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
  hoisted.lookup.mockReset().mockResolvedValue(null);
  hoisted.store.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SCOPED_DB = { scoped: true } as unknown as AthlyaDb;

function buildAppWithIdempotency() {
  const idempotencyFor = vi.fn(() => ({ db: SCOPED_DB }));
  const deps = buildStubDeps({
    auth: {
      register: vi.fn().mockResolvedValue(SESSION),
      login: vi.fn().mockResolvedValue(SESSION),
      deleteMe: vi.fn().mockResolvedValue(undefined),
      idempotencyFor,
    },
  });
  return { deps, idempotencyFor, app: buildApp({ deps }) };
}

const publicHeaders = {
  'content-type': 'application/json',
  'cf-turnstile-token': 'test-token',
  'Idempotency-Key': 'public-key-1',
};

describe('public auth routes with an Idempotency-Key header', () => {
  it('POST /v1/auth/login returns its normal status', async () => {
    const { app, deps, idempotencyFor } = buildAppWithIdempotency();

    const res = await app.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: publicHeaders,
        body: JSON.stringify({ email: 'ada@example.com', password: 'hunter2' }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(deps.auth.login).toHaveBeenCalledTimes(1);
    expect(idempotencyFor).not.toHaveBeenCalled();
    expect(hoisted.lookup).not.toHaveBeenCalled();
    expect(hoisted.store).not.toHaveBeenCalled();
  });

  it('POST /v1/auth/register returns its normal status', async () => {
    const { app, deps, idempotencyFor } = buildAppWithIdempotency();

    const res = await app.request(
      '/v1/auth/register',
      {
        method: 'POST',
        headers: publicHeaders,
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Password1234',
          displayName: 'Ada',
          studioSlug: 'athlya-paris',
          consents: { marketing: false, analytics: false, thirdParty: false },
        }),
      },
      env(),
    );

    expect(res.status).toBe(201);
    expect(deps.auth.register).toHaveBeenCalledTimes(1);
    expect(idempotencyFor).not.toHaveBeenCalled();
    expect(hoisted.lookup).not.toHaveBeenCalled();
    expect(hoisted.store).not.toHaveBeenCalled();
  });
});

describe('authenticated auth route with an Idempotency-Key header', () => {
  it('DELETE /v1/auth/me replays the cached response', async () => {
    hoisted.lookup.mockResolvedValue({ response: { deleted: true }, statusCode: 200 });
    const { app, deps } = buildAppWithIdempotency();
    const token = await mintAuthJwt(kp);

    const res = await app.request(
      '/v1/auth/me',
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': 'delete-key-1' },
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(await readJson<{ deleted: boolean }>(res)).toEqual({ deleted: true });
    expect(hoisted.lookup).toHaveBeenCalledTimes(1);
    expect(deps.auth.deleteMe).not.toHaveBeenCalled();
  });

  it('DELETE /v1/auth/me runs lookup and store on a store bound to the caller claims (issue #645)', async () => {
    const { app, deps, idempotencyFor } = buildAppWithIdempotency();
    const token = await mintAuthJwt(kp);

    const res = await app.request(
      '/v1/auth/me',
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': 'delete-key-2' },
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(deps.auth.deleteMe).toHaveBeenCalledWith(TEST_USER_ID);
    expect(idempotencyFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'member' }),
    );
    expect(hoisted.lookup).toHaveBeenCalledWith(SCOPED_DB, 'delete-key-2', TEST_USER_ID);
    expect(hoisted.store).toHaveBeenCalledWith(
      SCOPED_DB,
      'delete-key-2',
      TEST_USER_ID,
      { body: { deleted: true }, statusCode: 200 },
      86_400,
    );
  });

  it('DELETE /v1/auth/me runs without replay protection when no store is wired', async () => {
    const deleteMe = vi.fn().mockResolvedValue(undefined);
    const deps = buildStubDeps({ auth: { deleteMe, idempotencyFor: () => undefined } });
    const app = buildApp({ deps });
    const token = await mintAuthJwt(kp);

    const res = await app.request(
      '/v1/auth/me',
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': 'delete-key-3' },
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(deleteMe).toHaveBeenCalledTimes(1);
    expect(hoisted.lookup).not.toHaveBeenCalled();
    expect(hoisted.store).not.toHaveBeenCalled();
  });
});
