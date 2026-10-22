/**
 * `GET /v1/auth/sessions` and `DELETE /v1/auth/sessions/:id` (issue #757).
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
import type { AuthDeps } from '../../routes/auth.js';
import type { ActiveSession } from '@athlya/shared/schemas/api';

const hoisted = vi.hoisted(() => ({ localResolver: null as JwksKeyResolver | null }));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (hoisted.localResolver === null) throw new Error('local resolver not initialised');
        return hoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const HANDLE = 'a'.repeat(32);

const SESSION: ActiveSession = {
  id: HANDLE,
  device: { browser: 'chrome', os: 'macos' },
  createdAt: '2026-10-20T08:00:00.000Z',
  lastSeenAt: '2026-10-21T08:00:00.000Z',
  expiresAt: '2026-11-20T08:00:00.000Z',
  current: true,
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  hoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(
  auth: Partial<AuthDeps>,
  method: string,
  path: string,
  sessionHandle?: string,
): Promise<Response> {
  const app = buildApp({ deps: buildStubDeps({ auth }) });
  const token = await mintAuthJwt(kp, sessionHandle !== undefined ? { sessionHandle } : {});
  return app.request(path, { method, headers: { authorization: `Bearer ${token}` } }, env());
}

describe('GET /v1/auth/sessions', () => {
  it("lists the caller's sessions, passing the session handle of the access token", async () => {
    const listSessions = vi.fn<AuthDeps['listSessions']>().mockResolvedValue([SESSION]);

    const res = await call({ listSessions }, 'GET', '/v1/auth/sessions', HANDLE);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson(res)).toEqual({ items: [SESSION] });
    expect(listSessions).toHaveBeenCalledWith(TEST_USER_ID, HANDLE);
  });

  it('passes no handle for a token minted before the claim existed', async () => {
    const listSessions = vi.fn<AuthDeps['listSessions']>().mockResolvedValue([]);

    await call({ listSessions }, 'GET', '/v1/auth/sessions');

    expect(listSessions).toHaveBeenCalledWith(TEST_USER_ID, undefined);
  });

  it('answers 401 without a token', async () => {
    const listSessions = vi.fn<AuthDeps['listSessions']>();
    const app = buildApp({ deps: buildStubDeps({ auth: { listSessions } }) });

    const res = await app.request('/v1/auth/sessions', { method: 'GET' }, env());

    expect(res.status).toBe(401);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/auth/sessions/:id', () => {
  it('revokes a session of the caller', async () => {
    const revokeSession = vi.fn<AuthDeps['revokeSession']>().mockResolvedValue(true);

    const res = await call({ revokeSession }, 'DELETE', `/v1/auth/sessions/${HANDLE}`);

    expect(res.status).toBe(204);
    expect(revokeSession).toHaveBeenCalledWith(TEST_USER_ID, HANDLE);
  });

  it('answers 404 when the caller has no such session', async () => {
    const revokeSession = vi.fn<AuthDeps['revokeSession']>().mockResolvedValue(false);

    const res = await call({ revokeSession }, 'DELETE', `/v1/auth/sessions/${HANDLE}`);

    expect(res.status).toBe(404);
    expect((await readJson<{ code: string }>(res)).code).toBe('session_not_found');
  });

  it('rejects a malformed id with 422 before reaching the store', async () => {
    const revokeSession = vi.fn<AuthDeps['revokeSession']>();

    const res = await call({ revokeSession }, 'DELETE', '/v1/auth/sessions/not-a-handle');

    expect(res.status).toBe(422);
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
