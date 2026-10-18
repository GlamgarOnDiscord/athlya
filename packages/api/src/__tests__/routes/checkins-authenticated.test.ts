/**
 * `/v1/checkins/*` with a valid session — issue #654.
 *
 * Covers token issuance for any member, the admin/coach guard of the
 * kiosk scan, the outcome → HTTP mapping (401 for token failures, 422
 * for reservation-state failures), the kiosk response contract and
 * idempotency bound to the operator's claims.
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
import type { CheckInFailReason } from '../../routes/checkins.js';
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

const SUCCESS = {
  kind: 'success' as const,
  reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  member: { id: TEST_USER_ID, displayName: 'Ada', avatarUrl: null },
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
  hoisted.lookup.mockReset().mockResolvedValue(null);
  hoisted.store.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  path: string,
  options: {
    role?: 'member' | 'coach' | 'admin';
    userId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const token = await mintAuthJwt(kp, {
    role: options.role ?? 'member',
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
  });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return buildApp({ deps }).request(
    `/v1/checkins${path}`,
    {
      method: 'POST',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    env(),
  );
}

describe('POST /v1/checkins/token', () => {
  it('issues a token for the caller and forbids caching it', async () => {
    const issued = { token: 'h.p.s', expiresAt: '2026-10-18T10:02:00.000Z' };
    const issueToken = vi.fn().mockResolvedValue(issued);
    const deps = buildStubDeps({ checkins: { issueToken } });

    const res = await call(deps, '/token');

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await readJson<unknown>(res)).toEqual(issued);
    expect(issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'member' }),
    );
  });

  it('requires a session', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request('/v1/checkins/token', { method: 'POST' }, env());
    expect(res.status).toBe(401);
    expect(deps.checkins.issueToken).not.toHaveBeenCalled();
  });
});

describe('POST /v1/checkins (kiosk)', () => {
  it('refuses a member with 403: a member cannot check themselves in', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, '', { role: 'member', body: { qrToken: 'h.p.s' } });
    expect(res.status).toBe(403);
    expect(deps.checkins.checkIn).not.toHaveBeenCalled();
  });

  it.each(['coach', 'admin'] as const)(
    'lets a %s check the member in and returns the kiosk contract',
    async (role) => {
      const checkIn = vi.fn().mockResolvedValue(SUCCESS);
      const deps = buildStubDeps({ checkins: { checkIn } });

      const res = await call(deps, '', { role, body: { qrToken: 'h.p.s' } });

      expect(res.status).toBe(200);
      expect(await readJson<unknown>(res)).toEqual({
        success: true,
        reservationId: SUCCESS.reservationId,
        member: SUCCESS.member,
      });
      expect(checkIn).toHaveBeenCalledWith(
        expect.objectContaining({ studioId: TEST_STUDIO_ID, role }),
        { qrToken: 'h.p.s' },
      );
    },
  );

  it.each([
    ['invalid_signature', 401],
    ['token_expired', 401],
    ['replay', 401],
    ['wrong_studio', 401],
    ['wrong_kind', 401],
    ['malformed', 401],
    ['no_reservation', 422],
    ['outside_window', 422],
    ['already_checked_in', 422],
    ['checkin_limit_reached', 429],
  ] as const)('maps %s to %i with the reason as code', async (reason, status) => {
    const checkIn = vi
      .fn()
      .mockResolvedValue({ kind: 'fail', reason: reason satisfies CheckInFailReason });
    const deps = buildStubDeps({ checkins: { checkIn } });

    const res = await call(deps, '', { role: 'coach', body: { qrToken: 'h.p.s' } });

    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await readJson<{ code?: string }>(res)).toMatchObject({ code: reason });
    expect(res.headers.get('retry-after')).toBe(status === 429 ? '3600' : null);
  });

  it('rejects a body without qrToken with 422 before the service runs', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, '', { role: 'coach', body: {} });
    expect(res.status).toBe(422);
    expect(deps.checkins.checkIn).not.toHaveBeenCalled();
  });

  it('stores the success under the operator and replays it only to that operator', async () => {
    const operatorA = '44444444-4444-4444-8444-444444444441';
    const operatorB = '44444444-4444-4444-8444-444444444442';
    const checkIn = vi.fn().mockResolvedValue(SUCCESS);
    const idempotencyFor = vi.fn().mockReturnValue({ db: {} as AthlyaDb });
    const deps = buildStubDeps({ checkins: { checkIn, idempotencyFor } });
    const scan = (userId: string) =>
      call(deps, '', {
        role: 'coach',
        userId,
        body: { qrToken: 'h.p.s' },
        headers: { 'Idempotency-Key': 'scan-1' },
      });

    const first = await scan(operatorA);
    expect(first.status).toBe(200);
    const stored = await readJson<unknown>(first);
    expect(idempotencyFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: operatorA, role: 'coach' }),
    );
    expect(hoisted.lookup).toHaveBeenCalledWith(expect.anything(), 'scan-1', operatorA);
    expect(hoisted.store).toHaveBeenCalledWith(
      expect.anything(),
      'scan-1',
      operatorA,
      { body: stored, statusCode: 200 },
      expect.any(Number),
    );

    // The store is owner-scoped: operator A's retry finds the entry.
    hoisted.lookup.mockImplementation((_db: unknown, key: string, userId: string) =>
      Promise.resolve(
        key === 'scan-1' && userId === operatorA
          ? { response: stored, statusCode: 200, createdAt: new Date(), expiresAt: new Date() }
          : null,
      ),
    );
    const retry = await scan(operatorA);
    expect(retry.status).toBe(200);
    expect(checkIn).toHaveBeenCalledTimes(1);

    // Operator B reusing the key does not replay A's response.
    const other = await scan(operatorB);
    expect(other.status).toBe(200);
    expect(hoisted.lookup).toHaveBeenLastCalledWith(expect.anything(), 'scan-1', operatorB);
    expect(checkIn).toHaveBeenCalledTimes(2);
  });
});
