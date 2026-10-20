/**
 * `/v1/reservations/*` with a valid token: the replay answers carry the
 * real reservation state, a retried cancel stays a success, and both
 * mutations run the strict idempotency mode resolved from the caller's
 * claims.
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

const CLASS_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION = { id: RESERVATION_ID, classId: CLASS_ID, userId: TEST_USER_ID };

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

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = await mintAuthJwt(kp, { userId: TEST_USER_ID });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return buildApp({ deps }).request(
    `/v1/reservations${path}`,
    {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    env(),
  );
}

describe('POST /v1/reservations: replay of an existing booking', () => {
  it('answers 409 with the real waitlist status and position', async () => {
    const bookClass = vi.fn().mockResolvedValue({
      kind: 'conflict',
      status: 'waitlist',
      reservation: { ...RESERVATION, status: 'waitlist' },
      position: 3,
    });
    const deps = buildStubDeps({ reservations: { bookClass } });

    const res = await call(deps, 'POST', '', { body: { classId: CLASS_ID } });

    expect(res.status).toBe(409);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({
      status: 'waitlist',
      position: 3,
    });
  });

  it('answers 409 confirmed without a position for a confirmed seat', async () => {
    const bookClass = vi.fn().mockResolvedValue({
      kind: 'conflict',
      status: 'confirmed',
      reservation: { ...RESERVATION, status: 'confirmed' },
    });
    const deps = buildStubDeps({ reservations: { bookClass } });

    const res = await call(deps, 'POST', '', { body: { classId: CLASS_ID } });

    const body = await readJson<Record<string, unknown>>(res);
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ status: 'confirmed' });
    expect(body).not.toHaveProperty('position');
  });
});

describe('DELETE /v1/reservations/:id: retried cancel', () => {
  it('answers 200 with alreadyCancelled instead of a 422', async () => {
    const cancelReservation = vi.fn().mockResolvedValue({
      kind: 'already_cancelled',
      reservation: { ...RESERVATION, status: 'cancelled' },
    });
    const deps = buildStubDeps({ reservations: { cancelReservation } });

    const res = await call(deps, 'DELETE', `/${RESERVATION_ID}`);

    expect(res.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({
      status: 'cancelled',
      alreadyCancelled: true,
    });
  });
});

describe('strict idempotency on the reservation mutations', () => {
  it('resolves the store from the caller claims and fails closed when it is down', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({
      db: {} as AthlyaDb,
      bindRequest: true,
      failClosed: true,
    });
    const bookClass = vi.fn();
    const deps = buildStubDeps({ reservations: { bookClass, idempotencyFor } });
    hoisted.lookup.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await call(deps, 'POST', '', {
      body: { classId: CLASS_ID },
      headers: { 'Idempotency-Key': 'book-1' },
    });

    expect(idempotencyFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
    expect(res.status).toBe(503);
    expect(bookClass).not.toHaveBeenCalled();
  });

  it('refuses a booking key replayed for another class', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({ db: {} as AthlyaDb, bindRequest: true });
    const bookClass = vi.fn().mockResolvedValue({ kind: 'confirmed', reservation: RESERVATION });
    const deps = buildStubDeps({ reservations: { bookClass, idempotencyFor } });

    await call(deps, 'POST', '', {
      body: { classId: CLASS_ID },
      headers: { 'Idempotency-Key': 'book-2' },
    });
    const stored = hoisted.store.mock.calls[0]?.[3] as {
      body: Record<string, unknown>;
      statusCode: number;
    };
    hoisted.lookup.mockResolvedValueOnce({ response: stored.body, statusCode: stored.statusCode });

    const reused = await call(deps, 'POST', '', {
      body: { classId: '33333333-3333-4333-8333-333333333333' },
      headers: { 'Idempotency-Key': 'book-2' },
    });

    expect(reused.status).toBe(422);
    expect(bookClass).toHaveBeenCalledTimes(1);
  });
});
