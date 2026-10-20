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

describe('seat holds (issue #723)', () => {
  const EXPIRES_AT = new Date('2030-01-01T09:10:00.000Z');
  const HOLD = { reservationId: RESERVATION_ID, classId: CLASS_ID, expiresAt: EXPIRES_AT };

  it('POST /holds answers 201 with the hold, passing classVersion through', async () => {
    const placeHold = vi.fn().mockResolvedValue({ kind: 'held', hold: HOLD });
    const deps = buildStubDeps({ reservations: { placeHold } });

    const res = await call(deps, 'POST', '/holds', {
      body: { classId: CLASS_ID, classVersion: 3 },
    });

    expect(res.status).toBe(201);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toEqual({
      status: 'held',
      hold: {
        reservationId: RESERVATION_ID,
        classId: CLASS_ID,
        expiresAt: EXPIRES_AT.toISOString(),
      },
    });
    expect(placeHold).toHaveBeenCalledWith(expect.objectContaining({ userId: TEST_USER_ID }), {
      classId: CLASS_ID,
      classVersion: 3,
    });
  });

  it('POST /holds answers 200 with the active hold on a retry', async () => {
    const placeHold = vi.fn().mockResolvedValue({ kind: 'already_held', hold: HOLD });
    const deps = buildStubDeps({ reservations: { placeHold } });

    const res = await call(deps, 'POST', '/holds', { body: { classId: CLASS_ID } });

    expect(res.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({
      status: 'held',
    });
  });

  it.each([
    ['class_full', 409],
    ['class_changed', 409],
    ['class_in_past', 422],
    ['not_found', 404],
    ['counter_unavailable', 503],
  ] as const)('POST /holds maps %s to %i problem details', async (kind, status) => {
    const placeHold = vi.fn().mockResolvedValue({ kind });
    const deps = buildStubDeps({ reservations: { placeHold } });

    const res = await call(deps, 'POST', '/holds', { body: { classId: CLASS_ID } });

    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({ code: kind });
  });

  it('POST /holds answers 409 with the live booking the member already has', async () => {
    const placeHold = vi.fn().mockResolvedValue({
      kind: 'conflict',
      status: 'confirmed',
      reservation: { ...RESERVATION, status: 'confirmed' },
    });
    const deps = buildStubDeps({ reservations: { placeHold } });

    const res = await call(deps, 'POST', '/holds', { body: { classId: CLASS_ID } });

    expect(res.status).toBe(409);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({
      status: 'confirmed',
    });
  });

  it('POST /holds refuses an unknown body key', async () => {
    const placeHold = vi.fn();
    const deps = buildStubDeps({ reservations: { placeHold } });

    const res = await call(deps, 'POST', '/holds', {
      body: { classId: CLASS_ID, ttlSeconds: 86_400 },
    });

    expect(res.status).toBe(422);
    expect(placeHold).not.toHaveBeenCalled();
  });

  it('POST /:id/confirm answers 201 confirmed, then 200 on a retry', async () => {
    const confirmHold = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'confirmed',
        reservation: { ...RESERVATION, status: 'confirmed' },
      })
      .mockResolvedValueOnce({
        kind: 'already_confirmed',
        reservation: { ...RESERVATION, status: 'confirmed' },
      });
    const deps = buildStubDeps({ reservations: { confirmHold } });

    const first = await call(deps, 'POST', `/${RESERVATION_ID}/confirm`);
    const retry = await call(deps, 'POST', `/${RESERVATION_ID}/confirm`);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(first)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(confirmHold).toHaveBeenCalledWith(expect.objectContaining({ userId: TEST_USER_ID }), {
      reservationId: RESERVATION_ID,
    });
  });

  it.each([
    ['hold_expired', 409],
    ['not_a_hold', 409],
    ['not_found', 404],
  ] as const)('POST /:id/confirm maps %s to %i', async (kind, status) => {
    const confirmHold = vi.fn().mockResolvedValue({ kind });
    const deps = buildStubDeps({ reservations: { confirmHold } });

    const res = await call(deps, 'POST', `/${RESERVATION_ID}/confirm`);

    expect(res.status).toBe(status);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({ code: kind });
  });

  it('POST / maps a stale classVersion to 409 class_changed', async () => {
    const bookClass = vi.fn().mockResolvedValue({ kind: 'class_changed' });
    const deps = buildStubDeps({ reservations: { bookClass } });

    const res = await call(deps, 'POST', '', { body: { classId: CLASS_ID, classVersion: 1 } });

    expect(res.status).toBe(409);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toMatchObject({
      code: 'class_changed',
    });
  });

  it('runs the hold and confirm routes under strict idempotency', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({
      db: {} as AthlyaDb,
      bindRequest: true,
      failClosed: true,
    });
    const placeHold = vi.fn();
    const confirmHold = vi.fn();
    const deps = buildStubDeps({ reservations: { placeHold, confirmHold, idempotencyFor } });
    hoisted.lookup.mockRejectedValue(new Error('db unreachable'));

    const held = await call(deps, 'POST', '/holds', {
      body: { classId: CLASS_ID },
      headers: { 'Idempotency-Key': 'hold-1' },
    });
    const confirmed = await call(deps, 'POST', `/${RESERVATION_ID}/confirm`, {
      headers: { 'Idempotency-Key': 'confirm-1' },
    });

    expect(held.status).toBe(503);
    expect(confirmed.status).toBe(503);
    expect(placeHold).not.toHaveBeenCalled();
    expect(confirmHold).not.toHaveBeenCalled();
  });
});
