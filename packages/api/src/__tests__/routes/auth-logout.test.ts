/**
 * `POST /v1/auth/logout` and `POST /v1/auth/logout-all` route tests
 * (audit finding S2-010).
 *
 *   1. `/logout` forwards the refresh token from the body with the
 *      caller's `userId`, so only that session is revoked.
 *   2. `/logout` without a body forwards no refresh token (the adapter
 *      then keeps the legacy revoke-all behaviour).
 *   3. `/logout` rejects a malformed body with 422 before revoking.
 *   4. `/logout-all` revokes every session of the caller.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  TEST_USER_ID,
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';

const hoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildLogoutApp() {
  const deps = buildStubDeps({
    auth: {
      logout: vi.fn().mockResolvedValue(undefined),
      logoutAll: vi.fn().mockResolvedValue(undefined),
    },
  });
  return { deps, app: buildApp({ deps }) };
}

async function authHeaders(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await mintAuthJwt(kp)}`,
    'content-type': 'application/json',
  };
}

describe('POST /v1/auth/logout', () => {
  it('revokes only the session of the presented refresh token', async () => {
    const { app, deps } = buildLogoutApp();

    const res = await app.request(
      '/v1/auth/logout',
      {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ refreshToken: 'r.session-a' }),
      },
      env(),
    );

    expect(res.status).toBe(204);
    expect(deps.auth.logout).toHaveBeenCalledWith(TEST_USER_ID, 'r.session-a');
    expect(deps.auth.logoutAll).not.toHaveBeenCalled();
  });

  it('forwards no refresh token when the body is empty', async () => {
    const { app, deps } = buildLogoutApp();

    const res = await app.request(
      '/v1/auth/logout',
      { method: 'POST', headers: await authHeaders() },
      env(),
    );

    expect(res.status).toBe(204);
    expect(deps.auth.logout).toHaveBeenCalledWith(TEST_USER_ID, undefined);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an empty refresh token', JSON.stringify({ refreshToken: '' })],
    ['an unknown field', JSON.stringify({ refreshToken: 'r.t', everywhere: true })],
  ])('rejects %s with 422 and revokes nothing', async (_label, body) => {
    const { app, deps } = buildLogoutApp();

    const res = await app.request(
      '/v1/auth/logout',
      { method: 'POST', headers: await authHeaders(), body },
      env(),
    );

    expect(res.status).toBe(422);
    const problem = await readJson<{ status: number }>(res);
    expect(problem.status).toBe(422);
    expect(deps.auth.logout).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/logout-all', () => {
  it('revokes every session of the caller', async () => {
    const { app, deps } = buildLogoutApp();

    const res = await app.request(
      '/v1/auth/logout-all',
      { method: 'POST', headers: await authHeaders() },
      env(),
    );

    expect(res.status).toBe(204);
    expect(deps.auth.logoutAll).toHaveBeenCalledWith(TEST_USER_ID);
    expect(deps.auth.logout).not.toHaveBeenCalled();
  });

  it('returns 401 without an access token', async () => {
    const { app, deps } = buildLogoutApp();

    const res = await app.request('/v1/auth/logout-all', { method: 'POST' }, env());

    expect(res.status).toBe(401);
    expect(deps.auth.logoutAll).not.toHaveBeenCalled();
  });
});
