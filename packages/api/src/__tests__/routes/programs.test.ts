/**
 * `/v1/programs/*` router — Epic 24, issue #640.
 *
 * Covers authentication, admin vs member authorization, Zod
 * validation, the outcome → HTTP mapping, idempotency under the
 * caller's claims, and cross-studio isolation: the studio always comes
 * from the JWT, and a program hidden by RLS is a 404, never a 403.
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
import type {
  ProgramDetail,
  ProgramSubscription,
  TodayWorkoutResponse,
} from '@athlya/shared/schemas/api';

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

const PROGRAM_ID = '0b000000-0000-4000-8000-000000000001';
const OTHER_STUDIO_ID = '33333333-3333-4333-8333-333333333333';

const PROGRAM: ProgramDetail = {
  id: PROGRAM_ID,
  studioId: TEST_STUDIO_ID,
  title: 'Strength 101',
  description: null,
  status: 'published',
  version: 0,
  weekCount: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  archivedAt: null,
  weeks: [{ weekNumber: 1, title: null, workouts: [] }],
};

const SUBSCRIPTION: ProgramSubscription = {
  id: '0c000000-0000-4000-8000-000000000001',
  programId: PROGRAM_ID,
  programTitle: 'Strength 101',
  programStatus: 'published',
  startsOn: '2026-10-12',
  createdAt: '2026-10-12T08:00:00.000Z',
};

const CREATE_BODY = {
  title: 'Strength 101',
  weeks: [
    {
      weekNumber: 1,
      workouts: [
        { dayNumber: 1, title: 'Squat', exercises: [{ name: 'Back squat', sets: 5, reps: 5 }] },
      ],
    },
  ],
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

type Role = 'member' | 'coach' | 'admin';

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  method: string,
  path: string,
  options: {
    role?: Role;
    studioId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const token = await mintAuthJwt(kp, {
    role: options.role ?? 'member',
    studioId: options.studioId ?? TEST_STUDIO_ID,
  });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return buildApp({ deps }).request(
    `/v1/programs${path}`,
    {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    env(),
  );
}

describe('authentication', () => {
  it.each([
    ['GET', ''],
    ['GET', '/today'],
    ['POST', ''],
    ['POST', `/${PROGRAM_ID}/subscription`],
  ])('%s /v1/programs%s without a token → 401', async (method, path) => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(`/v1/programs${path}`, { method }, env());
    expect(res.status).toBe(401);
    expect(deps.programs.listPrograms).not.toHaveBeenCalled();
    expect(deps.programs.createProgram).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('GET / lists with the JWT claims and the validated filter', async () => {
    const deps = buildStubDeps({
      programs: { listPrograms: vi.fn().mockResolvedValue({ items: [PROGRAM] }) },
    });
    const res = await call(deps, 'GET', '?status=published');
    expect(res.status).toBe(200);
    expect(await readJson<{ items: unknown[] }>(res)).toEqual({ items: [PROGRAM] });
    expect(deps.programs.listPrograms).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'member' }),
      { status: 'published' },
    );
  });

  it('GET / rejects an unknown status or query key with 422', async () => {
    const deps = buildStubDeps();
    expect((await call(deps, 'GET', '?status=deleted')).status).toBe(422);
    expect((await call(deps, 'GET', '?studioId=x')).status).toBe(422);
    expect(deps.programs.listPrograms).not.toHaveBeenCalled();
  });

  it('GET /:id returns the program, and 404 when RLS hides it', async () => {
    const getProgram = vi.fn().mockResolvedValueOnce(PROGRAM).mockResolvedValueOnce(null);
    const deps = buildStubDeps({ programs: { getProgram } });
    const found = await call(deps, 'GET', `/${PROGRAM_ID}`);
    expect(found.status).toBe(200);
    expect(await readJson<ProgramDetail>(found)).toEqual(PROGRAM);
    const hidden = await call(deps, 'GET', `/${PROGRAM_ID}`);
    expect(hidden.status).toBe(404);
    expect(await readJson<{ code: string }>(hidden)).toMatchObject({ code: 'not_found' });
  });

  it('GET /:id rejects a non-uuid id with 422', async () => {
    const deps = buildStubDeps();
    expect((await call(deps, 'GET', '/not-a-uuid')).status).toBe(422);
    expect(deps.programs.getProgram).not.toHaveBeenCalled();
  });

  it('GET /subscriptions/me lists the caller subscriptions', async () => {
    const deps = buildStubDeps({
      programs: { listMySubscriptions: vi.fn().mockResolvedValue({ items: [SUBSCRIPTION] }) },
    });
    const res = await call(deps, 'GET', '/subscriptions/me');
    expect(res.status).toBe(200);
    expect(await readJson<{ items: unknown[] }>(res)).toEqual({ items: [SUBSCRIPTION] });
  });
});

describe('GET /today (mobile home contract)', () => {
  const TODAY: TodayWorkoutResponse = {
    date: '2026-10-18',
    items: [
      {
        subscriptionId: SUBSCRIPTION.id,
        program: { id: PROGRAM_ID, title: 'Strength 101' },
        startsOn: '2026-10-12',
        totalWeeks: 1,
        status: 'rest',
        weekNumber: 1,
        dayNumber: 7,
        workout: null,
      },
    ],
  };

  it('passes the member local date and is never cached by intermediaries', async () => {
    const getToday = vi.fn().mockResolvedValue(TODAY);
    const deps = buildStubDeps({ programs: { getToday } });
    const res = await call(deps, 'GET', '/today?date=2026-10-18');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson<TodayWorkoutResponse>(res)).toEqual(TODAY);
    expect(getToday).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID }),
      '2026-10-18',
    );
  });

  it('defaults the date server-side when omitted', async () => {
    const getToday = vi.fn().mockResolvedValue(TODAY);
    const deps = buildStubDeps({ programs: { getToday } });
    expect((await call(deps, 'GET', '/today')).status).toBe(200);
    expect(getToday).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('rejects a malformed date with 422 and an out-of-range one with invalid_date', async () => {
    const getToday = vi.fn().mockResolvedValue({ kind: 'invalid_date' });
    const deps = buildStubDeps({ programs: { getToday } });
    expect((await call(deps, 'GET', '/today?date=18-10-2026')).status).toBe(422);
    expect(getToday).not.toHaveBeenCalled();
    const res = await call(deps, 'GET', '/today?date=2030-01-01');
    expect(res.status).toBe(422);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'invalid_date' });
  });
});

describe('authoring is admin-only', () => {
  it.each(['member', 'coach'] as const)('a %s gets 403 on every authoring route', async (role) => {
    const deps = buildStubDeps();
    expect((await call(deps, 'POST', '', { role, body: CREATE_BODY })).status).toBe(403);
    expect(
      (await call(deps, 'PATCH', `/${PROGRAM_ID}`, { role, body: { version: 0, title: 'x' } }))
        .status,
    ).toBe(403);
    expect((await call(deps, 'POST', `/${PROGRAM_ID}/archive`, { role })).status).toBe(403);
    expect(deps.programs.createProgram).not.toHaveBeenCalled();
    expect(deps.programs.updateProgram).not.toHaveBeenCalled();
    expect(deps.programs.archiveProgram).not.toHaveBeenCalled();
  });

  it('POST / creates a program in the JWT studio → 201', async () => {
    const createProgram = vi.fn().mockResolvedValue({ kind: 'created', program: PROGRAM });
    const deps = buildStubDeps({ programs: { createProgram } });
    const res = await call(deps, 'POST', '', { role: 'admin', body: CREATE_BODY });
    expect(res.status).toBe(201);
    expect(await readJson<ProgramDetail>(res)).toEqual(PROGRAM);
    expect(createProgram).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: TEST_STUDIO_ID, role: 'admin' }),
      expect.objectContaining({ title: 'Strength 101' }),
    );
  });

  it.each([
    ['a body studioId', { ...CREATE_BODY, studioId: OTHER_STUDIO_ID }],
    ['a gap in the weeks', { ...CREATE_BODY, weeks: [{ ...CREATE_BODY.weeks[0], weekNumber: 2 }] }],
    [
      'two workouts on one day',
      {
        ...CREATE_BODY,
        weeks: [
          {
            weekNumber: 1,
            workouts: [
              { dayNumber: 1, title: 'A', exercises: [] },
              { dayNumber: 1, title: 'B', exercises: [] },
            ],
          },
        ],
      },
    ],
    [
      'day 8',
      {
        ...CREATE_BODY,
        weeks: [{ weekNumber: 1, workouts: [{ dayNumber: 8, title: 'A', exercises: [] }] }],
      },
    ],
    ['no weeks', { ...CREATE_BODY, weeks: [] }],
    ['an archived status', { ...CREATE_BODY, status: 'archived' }],
  ])('POST / rejects %s with 422', async (_label, body) => {
    const deps = buildStubDeps();
    const res = await call(deps, 'POST', '', { role: 'admin', body });
    expect(res.status).toBe(422);
    expect(deps.programs.createProgram).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'updated', program: PROGRAM }, 200, undefined],
    [{ kind: 'conflict' }, 409, 'version_conflict'],
    [{ kind: 'archived' }, 409, 'program_archived'],
    [{ kind: 'not_found' }, 404, 'not_found'],
  ])('PATCH /:id maps %j to %i', async (outcome, status, code) => {
    const updateProgram = vi.fn().mockResolvedValue(outcome);
    const deps = buildStubDeps({ programs: { updateProgram } });
    const res = await call(deps, 'PATCH', `/${PROGRAM_ID}`, {
      role: 'admin',
      body: { version: 0, status: 'published' },
    });
    expect(res.status).toBe(status);
    if (code !== undefined) {
      expect(await readJson<{ code: string }>(res)).toMatchObject({ code });
    }
    expect(updateProgram).toHaveBeenCalledWith(expect.anything(), PROGRAM_ID, {
      version: 0,
      status: 'published',
    });
  });

  it('PATCH /:id requires the version and at least one field', async () => {
    const deps = buildStubDeps();
    expect(
      (await call(deps, 'PATCH', `/${PROGRAM_ID}`, { role: 'admin', body: { title: 'x' } })).status,
    ).toBe(422);
    expect(
      (await call(deps, 'PATCH', `/${PROGRAM_ID}`, { role: 'admin', body: { version: 1 } })).status,
    ).toBe(422);
  });

  it('POST /:id/archive → 200, and 404 for another studio program', async () => {
    const archiveProgram = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'archived', program: { ...PROGRAM, status: 'archived' } })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ programs: { archiveProgram } });
    expect((await call(deps, 'POST', `/${PROGRAM_ID}/archive`, { role: 'admin' })).status).toBe(
      200,
    );
    const other = await call(deps, 'POST', `/${PROGRAM_ID}/archive`, {
      role: 'admin',
      studioId: OTHER_STUDIO_ID,
    });
    expect(other.status).toBe(404);
    expect(archiveProgram).toHaveBeenLastCalledWith(
      expect.objectContaining({ studioId: OTHER_STUDIO_ID }),
      PROGRAM_ID,
    );
  });
});

describe('subscriptions', () => {
  it.each([
    [{ kind: 'subscribed', subscription: SUBSCRIPTION }, 201, undefined],
    [{ kind: 'already_subscribed', subscription: SUBSCRIPTION }, 409, 'already_subscribed'],
    [{ kind: 'not_subscribable' }, 409, 'program_not_subscribable'],
    [{ kind: 'invalid_start' }, 422, 'invalid_start'],
    [{ kind: 'not_found' }, 404, 'not_found'],
  ])('POST /:id/subscription maps %j to %i', async (outcome, status, code) => {
    const subscribe = vi.fn().mockResolvedValue(outcome);
    const deps = buildStubDeps({ programs: { subscribe } });
    const res = await call(deps, 'POST', `/${PROGRAM_ID}/subscription`, {
      body: { startsOn: '2026-10-12' },
    });
    expect(res.status).toBe(status);
    if (code !== undefined) {
      expect(await readJson<{ code: string }>(res)).toMatchObject({ code });
    }
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
      PROGRAM_ID,
      { startsOn: '2026-10-12' },
    );
  });

  it('POST /:id/subscription refuses a user id or a malformed date in the body', async () => {
    const deps = buildStubDeps();
    const forged = await call(deps, 'POST', `/${PROGRAM_ID}/subscription`, {
      body: { userId: '44444444-4444-4444-8444-444444444444' },
    });
    expect(forged.status).toBe(422);
    const badDate = await call(deps, 'POST', `/${PROGRAM_ID}/subscription`, {
      body: { startsOn: '2026-02-30' },
    });
    expect(badDate.status).toBe(422);
    expect(deps.programs.subscribe).not.toHaveBeenCalled();
  });

  it('DELETE /:id/subscription → 204, then 404 without an active subscription', async () => {
    const unsubscribe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unsubscribed' })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deps = buildStubDeps({ programs: { unsubscribe } });
    expect((await call(deps, 'DELETE', `/${PROGRAM_ID}/subscription`)).status).toBe(204);
    expect((await call(deps, 'DELETE', `/${PROGRAM_ID}/subscription`)).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('scopes the store to the caller claims and replays a stored response', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({ db: {} as AthlyaDb });
    const createProgram = vi.fn().mockResolvedValue({ kind: 'created', program: PROGRAM });
    const deps = buildStubDeps({ programs: { createProgram, idempotencyFor } });

    const first = await call(deps, 'POST', '', {
      role: 'admin',
      body: CREATE_BODY,
      headers: { 'Idempotency-Key': 'create-1' },
    });
    expect(first.status).toBe(201);
    expect(idempotencyFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'admin' }),
    );
    expect(hoisted.store).toHaveBeenCalledWith(
      expect.anything(),
      'create-1',
      TEST_USER_ID,
      expect.objectContaining({ statusCode: 201 }),
      expect.any(Number),
    );

    hoisted.lookup.mockResolvedValueOnce({
      response: PROGRAM,
      statusCode: 201,
      createdAt: new Date(),
      expiresAt: new Date(),
    });
    const replay = await call(deps, 'POST', '', {
      role: 'admin',
      body: CREATE_BODY,
      headers: { 'Idempotency-Key': 'create-1' },
    });
    expect(replay.status).toBe(201);
    expect(createProgram).toHaveBeenCalledTimes(1);
  });

  it('runs the mutation without replay protection when no store is wired', async () => {
    const subscribe = vi.fn().mockResolvedValue({ kind: 'subscribed', subscription: SUBSCRIPTION });
    const deps = buildStubDeps({ programs: { subscribe } });
    const res = await call(deps, 'POST', `/${PROGRAM_ID}/subscription`, {
      body: {},
      headers: { 'Idempotency-Key': 'sub-1' },
    });
    expect(res.status).toBe(201);
    expect(hoisted.lookup).not.toHaveBeenCalled();
  });
});
