/**
 * `/v1/sessions/*` router — task 8.11, issue #652.
 *
 * Covers the auth chain order (401 before validation), validation of
 * Requirement 12.2/12.3 bounds, the claims handed to the deps (owner
 * and studio always come from the JWT), the `studio_mismatch` mapping,
 * and idempotency bound to the caller's claims.
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
import type { WorkoutSession } from '@athlya/shared/schemas/domain';

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

const OTHER_STUDIO_ID = '33333333-3333-4333-8333-333333333333';

const SESSION = {
  id: '0d000000-0000-4000-8000-000000000001',
  userId: TEST_USER_ID,
  studioId: null,
  startedAt: '2026-10-12T08:00:00.000Z',
  durationMin: 45,
  exercises: [{ name: 'Back squat', sets: [{ reps: 5, weightKg: 80 }] }],
  notes: null,
  createdAt: '2026-10-12T09:00:00.000Z',
} as unknown as WorkoutSession;

const LOG_BODY = {
  startedAt: '2026-10-12T08:00:00Z',
  durationMin: 45,
  exercises: [{ name: 'Back squat', sets: [{ reps: 5, weightKg: 80 }] }],
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

async function call(
  deps: ReturnType<typeof buildStubDeps>,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; userId?: string } = {},
): Promise<Response> {
  const token = await mintAuthJwt(kp, { userId: options.userId ?? TEST_USER_ID });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return buildApp({ deps }).request(
    `/v1/sessions${path}`,
    {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    },
    env(),
  );
}

describe('/v1/sessions — unauthenticated requests', () => {
  it('POST / → 401 missing_authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(LOG_BODY),
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('GET /me → 401 missing_authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/sessions/me?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z',
      { method: 'GET' },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.sessions.listSessions).not.toHaveBeenCalled();
  });

  it('POST / with oversized exercises array still surfaces 401 first (auth before validator)', async () => {
    const exercises = Array.from({ length: 51 }, (_, i) => ({
      name: `ex${i}`,
      sets: [{ reps: 10 }],
    }));
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startedAt: '2026-01-01T09:00:00Z', exercises }),
      },
      env(),
    );

    expect(res.status).toBe(401);
  });

  it('Problem Details 401 carries traceId matching x-trace-id', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request('/v1/sessions/me', { method: 'GET' }, env());

    const body = await readJson<{ traceId?: string }>(res);
    expect(body.traceId).toBe(res.headers.get('x-trace-id'));
  });
});

describe('POST /v1/sessions', () => {
  it('logs the session for the JWT subject and answers 201 with the stored row', async () => {
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession } });

    const res = await call(deps, 'POST', '', { body: LOG_BODY });

    expect(res.status).toBe(201);
    expect(await readJson<unknown>(res)).toEqual(SESSION);
    expect(logSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role: 'member' }),
      expect.objectContaining({ startedAt: LOG_BODY.startedAt, durationMin: 45 }),
      undefined,
    );
  });

  it('hands the trimmed Idempotency-Key to the deps so the write itself is idempotent', async () => {
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession } });

    const res = await call(deps, 'POST', '', {
      body: LOG_BODY,
      headers: { 'Idempotency-Key': ' drain-1 ' },
    });

    expect(res.status).toBe(201);
    expect(logSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'drain-1');
  });

  it('accepts a structured cardio summary and returns it (issue #667)', async () => {
    const cardio = {
      machine: 'treadmill',
      durationSec: 1_500,
      distanceM: 4_200,
      avgSpeedKmh: 10.1,
    };
    const stored = { ...SESSION, cardio } as WorkoutSession;
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: stored });
    const deps = buildStubDeps({ sessions: { logSession } });

    const res = await call(deps, 'POST', '', { body: { ...LOG_BODY, cardio } });

    expect(res.status).toBe(201);
    expect((await readJson<WorkoutSession>(res)).cardio).toEqual(cardio);
    expect(logSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cardio }),
      undefined,
    );
  });

  it('rejects an unknown cardio metric with 422', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, 'POST', '', {
      body: { ...LOG_BODY, cardio: { distanceM: 1_000, watts: 200 } },
    });
    expect(res.status).toBe(422);
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('rejects more than 50 exercises with 422 (Req 12.2)', async () => {
    const deps = buildStubDeps();
    const exercises = Array.from({ length: 51 }, (_, i) => ({ name: `e${i}`, sets: [] }));
    const res = await call(deps, 'POST', '', { body: { ...LOG_BODY, exercises } });
    expect(res.status).toBe(422);
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('rejects an exercise with more than 30 sets with 422 (Req 12.3)', async () => {
    const deps = buildStubDeps();
    const sets = Array.from({ length: 31 }, () => ({ reps: 1 }));
    const res = await call(deps, 'POST', '', {
      body: { ...LOG_BODY, exercises: [{ name: 'Row', sets }] },
    });
    expect(res.status).toBe(422);
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown field (a client cannot pick the owner)', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, 'POST', '', {
      body: { ...LOG_BODY, userId: '44444444-4444-4444-8444-444444444444' },
    });
    expect(res.status).toBe(422);
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('forwards the source of an imported session to the deps', async () => {
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession } });
    const source = { provider: 'appleHealth', externalId: '5B2D7C1E-3F4A-4B6C-8D9E-0F1A2B3C4D5E' };

    const res = await call(deps, 'POST', '', { body: { ...LOG_BODY, source } });

    expect(res.status).toBe(201);
    expect(await readJson<unknown>(res)).toEqual(SESSION);
    expect(logSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source }),
      undefined,
    );
  });

  it.each([
    ['an unknown provider', { provider: 'garmin', externalId: 'g-1' }],
    ['a missing external id', { provider: 'appleHealth' }],
    [
      'an external id over 128 characters',
      { provider: 'appleHealth', externalId: 'x'.repeat(129) },
    ],
  ])('rejects a source with %s with 422', async (_label, source) => {
    const deps = buildStubDeps();
    const res = await call(deps, 'POST', '', { body: { ...LOG_BODY, source } });
    expect(res.status).toBe(422);
    expect(deps.sessions.logSession).not.toHaveBeenCalled();
  });

  it('maps studio_mismatch to 422 Problem Details', async () => {
    const logSession = vi.fn().mockResolvedValue({ kind: 'studio_mismatch' });
    const deps = buildStubDeps({ sessions: { logSession } });

    const res = await call(deps, 'POST', '', { body: { ...LOG_BODY, studioId: OTHER_STUDIO_ID } });

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await readJson<{ code?: string }>(res)).toMatchObject({ code: 'studio_mismatch' });
  });
});

describe('GET /v1/sessions/me', () => {
  it('lists the caller sessions for the validated window', async () => {
    const listSessions = vi.fn().mockResolvedValue([SESSION]);
    const deps = buildStubDeps({ sessions: { listSessions } });

    const res = await call(deps, 'GET', '/me?from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z');

    expect(res.status).toBe(200);
    expect(await readJson<unknown>(res)).toEqual({ items: [SESSION] });
    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
      { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' },
    );
  });

  it('rejects a window over 90 days with 422', async () => {
    const deps = buildStubDeps();
    const res = await call(deps, 'GET', '/me?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z');
    expect(res.status).toBe(422);
    expect(deps.sessions.listSessions).not.toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  it('scopes the store to the caller claims and replays a stored response', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({ db: {} as AthlyaDb });
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession, idempotencyFor } });

    const first = await call(deps, 'POST', '', {
      body: LOG_BODY,
      headers: { 'Idempotency-Key': 'session-1' },
    });
    expect(first.status).toBe(201);
    expect(idempotencyFor).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
    expect(hoisted.store).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      TEST_USER_ID,
      expect.objectContaining({ statusCode: 201 }),
      expect.any(Number),
    );

    hoisted.lookup.mockResolvedValueOnce({
      response: SESSION,
      statusCode: 201,
      createdAt: new Date(),
      expiresAt: new Date(),
    });
    const replay = await call(deps, 'POST', '', {
      body: LOG_BODY,
      headers: { 'Idempotency-Key': 'session-1' },
    });
    expect(replay.status).toBe(201);
    expect(await readJson<unknown>(replay)).toEqual(SESSION);
    expect(logSession).toHaveBeenCalledTimes(1);
  });

  it('looks the key up under the caller identity, so another user never replays it', async () => {
    const idempotencyFor = vi.fn().mockReturnValue({ db: {} as AthlyaDb });
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession, idempotencyFor } });
    const otherUser = '44444444-4444-4444-8444-444444444444';

    await call(deps, 'POST', '', {
      userId: otherUser,
      body: LOG_BODY,
      headers: { 'Idempotency-Key': 'shared-key' },
    });

    expect(idempotencyFor).toHaveBeenCalledWith(expect.objectContaining({ userId: otherUser }));
    expect(hoisted.lookup).toHaveBeenCalledWith(expect.anything(), 'shared-key', otherUser);
  });

  it('logs without replay protection when no store is wired', async () => {
    const logSession = vi.fn().mockResolvedValue({ kind: 'created', session: SESSION });
    const deps = buildStubDeps({ sessions: { logSession } });
    const res = await call(deps, 'POST', '', {
      body: LOG_BODY,
      headers: { 'Idempotency-Key': 'session-2' },
    });
    expect(res.status).toBe(201);
    expect(hoisted.lookup).not.toHaveBeenCalled();
  });
});
