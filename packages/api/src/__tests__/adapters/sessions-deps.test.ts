/**
 * `buildSessionsDeps` (issue #652): the owner and the studio come from
 * the claims, a foreign `studioId` never reaches the database, and the
 * idempotency store is scoped to the caller.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionsDeps } from '../../adapters/sessions-deps.js';
import { buildMockEnv } from '../helpers/test-app.js';

import type { AuthClaims } from '../../middleware/auth.js';

const hoisted = vi.hoisted(() => ({
  create: vi.fn(),
  listByUser: vi.fn(),
  repoClaims: [] as unknown[],
  idemClaims: [] as unknown[],
}));

vi.mock('../../adapters/deps-cache.js', () => ({
  getOrCreateWriteDb: () => ({}),
  getOrCreateDbHttp: () => ({}),
}));

vi.mock('../../adapters/workout-sessions-repo-drizzle.js', () => ({
  WorkoutSessionStudioMismatchError: class WorkoutSessionStudioMismatchError extends Error {},
  createDrizzleWorkoutSessionRepo: (_db: unknown, claims: unknown) => {
    hoisted.repoClaims.push(claims);
    return { create: hoisted.create, listByUser: hoisted.listByUser };
  },
}));

vi.mock('../../adapters/tenant-idempotency.js', () => ({
  createTenantIdempotencyDb: (_db: unknown, claims: unknown) => {
    hoisted.idemClaims.push(claims);
    return { scoped: true };
  },
}));

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STUDIO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const claims = { userId: USER, studioId: STUDIO, role: 'member' } as AuthClaims;
const tenant = { userId: USER, studioId: STUDIO, role: 'member' };

beforeEach(() => {
  hoisted.create.mockReset().mockImplementation((input: unknown) => Promise.resolve(input));
  hoisted.listByUser.mockReset().mockResolvedValue([]);
  hoisted.repoClaims.length = 0;
  hoisted.idemClaims.length = 0;
});

describe('buildSessionsDeps', () => {
  const deps = buildSessionsDeps(buildMockEnv({ DB_URL: 'postgres://u:p@db.invalid/athlya' }));

  it('logs the session for the claims subject, in a repo scoped to the claims', async () => {
    const outcome = await deps.logSession(claims, {
      startedAt: '2026-10-12T08:00:00Z',
      exercises: [],
      studioId: STUDIO as never,
    });
    expect(outcome.kind).toBe('created');
    expect(hoisted.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, studioId: STUDIO }),
    );
    expect(hoisted.repoClaims).toEqual([tenant]);
  });

  it('refuses a studioId other than the caller studio without touching the repo', async () => {
    const outcome = await deps.logSession(claims, {
      startedAt: '2026-10-12T08:00:00Z',
      exercises: [],
      studioId: OTHER_STUDIO as never,
    });
    expect(outcome).toEqual({ kind: 'studio_mismatch' });
    expect(hoisted.create).not.toHaveBeenCalled();
  });

  it('forwards the idempotency key to the repo', async () => {
    await deps.logSession(claims, { startedAt: '2026-10-12T08:00:00Z', exercises: [] }, 'key-9');
    expect(hoisted.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-9' }),
    );
  });

  it('maps a repo studio mismatch to studio_mismatch', async () => {
    const { WorkoutSessionStudioMismatchError } =
      await import('../../adapters/workout-sessions-repo-drizzle.js');
    hoisted.create.mockRejectedValueOnce(new WorkoutSessionStudioMismatchError());
    const outcome = await deps.logSession(claims, {
      startedAt: '2026-10-12T08:00:00Z',
      exercises: [],
    });
    expect(outcome).toEqual({ kind: 'studio_mismatch' });
  });

  it('lists the caller sessions with the parsed window', async () => {
    await deps.listSessions(claims, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T00:00:00Z',
    });
    expect(hoisted.listByUser).toHaveBeenCalledWith(USER, {
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
      limit: 100,
    });
  });

  it('binds the idempotency store to the caller claims', () => {
    expect(deps.idempotencyFor?.(claims)).toEqual({ db: { scoped: true } });
    expect(hoisted.idemClaims).toEqual([tenant]);
  });
});
