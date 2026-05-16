/**
 * Unit tests for `@athlya/members/sessions`.
 *
 * Covers the two use cases added in task 5.5:
 *   - `logSession`   — Requirements 12.1, 12.2, 12.3.
 *   - `listSessions` — Requirement 12.4 (repo must do `ORDER BY
 *     started_at DESC`; the service's job is to guard the input and
 *     convert ISO strings to `Date` bounds).
 *
 * The repo is a hand-rolled `vi.fn()` double so the tests never touch
 * Drizzle or a real Postgres. That keeps the feedback loop tight and
 * matches the style of `./service.test.ts`.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import { MembersError } from '../service.js';
import {
  listSessions,
  logSession,
  type SessionsServiceDeps,
  type WorkoutSessionRepo,
} from '../sessions.js';

import type { WorkoutSession } from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const SESSION_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad';

/** Minimal valid log-session request body. */
const VALID_INPUT = {
  startedAt: '2026-01-10T08:00:00.000Z',
  durationMin: 45,
  exercises: [
    {
      name: 'Back squat',
      sets: [
        { reps: 5, weightKg: 100 },
        { reps: 5, weightKg: 100 },
        { reps: 3, weightKg: 110 },
      ],
    },
  ],
  notes: 'Felt strong today.',
  studioId: STUDIO_ID,
} as const;

/** Stored session row returned by the repo on the happy path. */
const STORED_SESSION: WorkoutSession = {
  id: SESSION_ID as WorkoutSession['id'],
  userId: USER_ID as WorkoutSession['userId'],
  studioId: STUDIO_ID as WorkoutSession['studioId'],
  startedAt: VALID_INPUT.startedAt,
  durationMin: VALID_INPUT.durationMin,
  exercises: [
    {
      name: 'Back squat',
      sets: [
        { reps: 5, weightKg: 100 },
        { reps: 5, weightKg: 100 },
        { reps: 3, weightKg: 110 },
      ],
    },
  ],
  notes: VALID_INPUT.notes,
  createdAt: '2026-01-10T08:45:00.000Z',
};

/** Build a fresh `SessionsServiceDeps` with `vi.fn()` repo doubles. */
function buildDeps(): {
  deps: SessionsServiceDeps;
  create: Mock<WorkoutSessionRepo['create']>;
  listByUser: Mock<WorkoutSessionRepo['listByUser']>;
} {
  const create = vi.fn<WorkoutSessionRepo['create']>();
  const listByUser = vi.fn<WorkoutSessionRepo['listByUser']>();
  const repo: WorkoutSessionRepo = { create, listByUser };
  return { deps: { repo }, create, listByUser };
}

/* ------------------------------------------------------------------ */
/*  logSession                                                         */
/* ------------------------------------------------------------------ */

describe('logSession', () => {
  it('persists a valid payload through the repo and returns the stored session', async () => {
    const { deps, create } = buildDeps();
    create.mockResolvedValueOnce(STORED_SESSION);

    const result = await logSession(USER_ID, VALID_INPUT, deps);

    expect(result).toBe(STORED_SESSION);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      userId: USER_ID,
      studioId: STUDIO_ID,
      startedAt: VALID_INPUT.startedAt,
      durationMin: VALID_INPUT.durationMin,
      exercises: VALID_INPUT.exercises,
      notes: VALID_INPUT.notes,
    });
  });

  it('omits optional fields from the repo payload when absent', async () => {
    const { deps, create } = buildDeps();
    create.mockResolvedValueOnce(STORED_SESSION);

    await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [{ name: 'Pull-ups', sets: [{ reps: 10 }] }],
      },
      deps,
    );

    // durationMin / notes / studioId must NOT appear on the repo call
    // when the caller omitted them — undefined must not be serialised.
    const call = create.mock.calls[0]?.[0];
    expect(call).toEqual({
      userId: USER_ID,
      startedAt: '2026-01-10T08:00:00.000Z',
      exercises: [{ name: 'Pull-ups', sets: [{ reps: 10 }] }],
    });
    expect(Object.prototype.hasOwnProperty.call(call, 'durationMin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(call, 'notes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(call, 'studioId')).toBe(false);
  });

  it('rejects payloads with more than 50 exercises (Req 12.2) at path [exercises]', async () => {
    const { deps, create } = buildDeps();

    const exercises = Array.from({ length: 51 }, (_, i) => ({
      name: `Exercise ${i + 1}`,
      sets: [{ reps: 5 }],
    }));

    const err = await logSession(
      USER_ID,
      { startedAt: '2026-01-10T08:00:00.000Z', exercises },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect((err as MembersError).issues?.some((i) => i.path === 'exercises')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an exercise with more than 30 sets (Req 12.3) at path [exercises.0.sets]', async () => {
    const { deps, create } = buildDeps();

    const sets = Array.from({ length: 31 }, () => ({ reps: 5 }));
    const err = await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [{ name: 'Bench press', sets }],
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect((err as MembersError).issues?.some((i) => i.path === 'exercises.0.sets')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects negative reps', async () => {
    const { deps, create } = buildDeps();

    const err = await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [{ name: 'Deadlift', sets: [{ reps: -1, weightKg: 100 }] }],
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    // Path should point at the offending reps field.
    expect((err as MembersError).issues?.some((i) => i.path.endsWith('reps'))).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level fields (.strict())', async () => {
    const { deps, create } = buildDeps();

    const err = await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [{ name: 'Rows', sets: [{ reps: 8 }] }],
        hacked: true,
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(create).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  listSessions                                                       */
/* ------------------------------------------------------------------ */

describe('listSessions', () => {
  it('converts from/to strings to Date bounds and calls the repo with limit=100', async () => {
    const { deps, listByUser } = buildDeps();
    listByUser.mockResolvedValueOnce([STORED_SESSION]);

    const result = await listSessions(
      USER_ID,
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
      },
      deps,
    );

    expect(result).toEqual([STORED_SESSION]);
    expect(listByUser).toHaveBeenCalledTimes(1);
    const [userArg, optsArg] = listByUser.mock.calls[0]!;
    expect(userArg).toBe(USER_ID);
    expect(optsArg.limit).toBe(100);
    expect(optsArg.from).toBeInstanceOf(Date);
    expect(optsArg.to).toBeInstanceOf(Date);
    expect(optsArg.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(optsArg.to.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('rejects an inverted range (to <= from) with validation_failed', async () => {
    const { deps, listByUser } = buildDeps();

    const err = await listSessions(
      USER_ID,
      {
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(listByUser).not.toHaveBeenCalled();
  });

  it('rejects a range wider than 90 days with validation_failed', async () => {
    const { deps, listByUser } = buildDeps();

    const err = await listSessions(
      USER_ID,
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-05-01T00:00:00.000Z', // ~120 days
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(listByUser).not.toHaveBeenCalled();
  });

  it('rejects malformed ISO strings with validation_failed', async () => {
    const { deps, listByUser } = buildDeps();

    const err = await listSessions(
      USER_ID,
      { from: 'not-a-date', to: '2026-01-31T00:00:00.000Z' },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(listByUser).not.toHaveBeenCalled();
  });

  it('returns the repo list unchanged (repo is responsible for ORDER BY started_at DESC)', async () => {
    const { deps, listByUser } = buildDeps();
    const page = [
      { ...STORED_SESSION, startedAt: '2026-01-20T08:00:00.000Z' },
      { ...STORED_SESSION, startedAt: '2026-01-10T08:00:00.000Z' },
    ];
    listByUser.mockResolvedValueOnce(page);

    const result = await listSessions(
      USER_ID,
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
      },
      deps,
    );

    // Service must not reorder — the repo's ORDER BY clause is
    // authoritative (Requirement 12.4).
    expect(result).toBe(page);
  });
});
