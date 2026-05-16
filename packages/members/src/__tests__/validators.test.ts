/**
 * Unit tests for Members service validators — task 5.7.
 *
 * These tests focus exclusively on the input-validation contract
 * enforced by the two validator-heavy service entry points, on top of
 * what the use-case tests in `./service.test.ts` and
 * `./sessions.test.ts` already cover. They exist as a dedicated file
 * so the mapping to the task-5.7 acceptance criteria is obvious to
 * any future reader:
 *
 *   - (a, b, c) `updateProfile` rejects displayNames of length 0 and
 *     81, and accepts the [1, 80] boundary pair — Requirement 3.4.
 *   - (d) `logSession` rejects when `exercises.length > 50`
 *     — Requirement 12.2.
 *   - (e) `logSession` rejects when any exercise has
 *     `sets.length > 30` — Requirement 12.3.
 *   - (f) `logSession` accepts the boundary payload with exactly 50
 *     exercises × 30 sets — Requirements 12.2 + 12.3.
 *
 * The repos are hand-rolled `vi.fn()` doubles so the tests never touch
 * Drizzle, Postgres or any network adapter: they exercise the Zod
 * schema layer and the service's error-shaping code in pure isolation.
 * A `validation_failed` error is treated as equivalent to the HTTP
 * 422 response the API gateway renders from it (Requirement 14.6).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  MembersError,
  updateProfile,
  type MemberProfile,
  type MemberRepo,
  type MembersServiceDeps,
} from '../service.js';
import { logSession, type SessionsServiceDeps, type WorkoutSessionRepo } from '../sessions.js';

import type { WorkoutSession } from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';

/** Minimal valid profile returned by the repo on the happy path. */
const PROFILE_FIXTURE: MemberProfile = {
  id: USER_ID,
  studioId: STUDIO_ID,
  email: 'member@example.test',
  displayName: 'Karim',
  avatarUrl: null,
  role: 'member',
  consents: {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: '2026-01',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Build a fresh members `MembersServiceDeps` with `vi.fn()` doubles. */
function buildMembersDeps(): {
  deps: MembersServiceDeps;
  findProfile: Mock<MemberRepo['findProfile']>;
  updateProfile: Mock<MemberRepo['updateProfile']>;
  listByStudio: Mock<MemberRepo['listByStudio']>;
} {
  const findProfile = vi.fn<MemberRepo['findProfile']>();
  const updateProfileFn = vi.fn<MemberRepo['updateProfile']>();
  const listByStudio = vi.fn<MemberRepo['listByStudio']>();
  const repo: MemberRepo = {
    findProfile,
    updateProfile: updateProfileFn,
    listByStudio,
  };
  return {
    deps: { repo },
    findProfile,
    updateProfile: updateProfileFn,
    listByStudio,
  };
}

/** Build a fresh sessions `SessionsServiceDeps` with `vi.fn()` doubles. */
function buildSessionsDeps(): {
  deps: SessionsServiceDeps;
  create: Mock<WorkoutSessionRepo['create']>;
  listByUser: Mock<WorkoutSessionRepo['listByUser']>;
} {
  const create = vi.fn<WorkoutSessionRepo['create']>();
  const listByUser = vi.fn<WorkoutSessionRepo['listByUser']>();
  const repo: WorkoutSessionRepo = { create, listByUser };
  return { deps: { repo }, create, listByUser };
}

/**
 * Assert that `err` is the `MembersError('validation_failed')` variant
 * that the API gateway maps to HTTP 422 and return a narrowed handle
 * so individual tests can drill into `.issues` without extra casts.
 */
function expectValidationFailed(err: unknown): MembersError {
  expect(err).toBeInstanceOf(MembersError);
  const m = err as MembersError;
  expect(m.code).toBe('validation_failed');
  return m;
}

/* ================================================================== */
/*  (a) (b) (c)  updateProfile — displayName length bounds             */
/* ================================================================== */

describe('updateProfile — displayName length bounds (Requirement 3.4)', () => {
  /* -- (a) length 0 → 422 ---------------------------------------- */

  it('(a) rejects a displayName of length 0 with validation_failed', async () => {
    const { deps, updateProfile: repoUpdate } = buildMembersDeps();

    const err = await updateProfile(USER_ID, { displayName: '' }, deps).catch((e: unknown) => e);

    const m = expectValidationFailed(err);
    expect(m.issues?.some((i) => i.path === 'displayName')).toBe(true);
    // Validation failures must never reach the repo.
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  /* -- (b) length 81 → 422 --------------------------------------- */

  it('(b) rejects a displayName of length 81 with validation_failed', async () => {
    const { deps, updateProfile: repoUpdate } = buildMembersDeps();

    const tooLong = 'x'.repeat(81);
    expect(tooLong).toHaveLength(81);

    const err = await updateProfile(USER_ID, { displayName: tooLong }, deps).catch(
      (e: unknown) => e,
    );

    const m = expectValidationFailed(err);
    expect(m.issues?.some((i) => i.path === 'displayName')).toBe(true);
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  /* -- (c) length 1 and 80 both accepted ------------------------- */

  it('(c) accepts a displayName of length 1 at the lower boundary', async () => {
    const { deps, updateProfile: repoUpdate } = buildMembersDeps();

    // Single non-whitespace code point — trims to length 1.
    const boundary = 'K';
    expect(boundary).toHaveLength(1);

    repoUpdate.mockResolvedValueOnce({
      ...PROFILE_FIXTURE,
      displayName: boundary,
    });

    const result = await updateProfile(USER_ID, { displayName: boundary }, deps);

    expect(result.displayName).toBe(boundary);
    // Service must hand the parsed patch straight through unchanged.
    expect(repoUpdate).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      displayName: boundary,
    });
  });

  it('(c) accepts a displayName of length 80 at the upper boundary', async () => {
    const { deps, updateProfile: repoUpdate } = buildMembersDeps();

    const boundary = 'y'.repeat(80);
    expect(boundary).toHaveLength(80);

    repoUpdate.mockResolvedValueOnce({
      ...PROFILE_FIXTURE,
      displayName: boundary,
    });

    const result = await updateProfile(USER_ID, { displayName: boundary }, deps);

    expect(result.displayName).toBe(boundary);
    expect(repoUpdate).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      displayName: boundary,
    });
  });
});

/* ================================================================== */
/*  (d) logSession — > 50 exercises rejected                           */
/* ================================================================== */

describe('logSession — exercise count bound (Requirement 12.2)', () => {
  /** Build a minimal valid exercise with one set (reps only). */
  function oneSetExercise(name: string) {
    return { name, sets: [{ reps: 5 }] } as const;
  }

  it('(d) rejects a payload with 51 exercises with validation_failed', async () => {
    const { deps, create } = buildSessionsDeps();

    const exercises = Array.from({ length: 51 }, (_, i) => oneSetExercise(`Exercise ${i + 1}`));
    expect(exercises).toHaveLength(51);

    const err = await logSession(
      USER_ID,
      { startedAt: '2026-01-10T08:00:00.000Z', exercises },
      deps,
    ).catch((e: unknown) => e);

    const m = expectValidationFailed(err);
    // The upper-bound violation points at the exercises array itself.
    expect(m.issues?.some((i) => i.path === 'exercises')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  (e) logSession — > 30 sets per exercise rejected                   */
/* ================================================================== */

describe('logSession — set count bound (Requirement 12.3)', () => {
  it('(e) rejects a payload where the first exercise has 31 sets', async () => {
    const { deps, create } = buildSessionsDeps();

    const sets = Array.from({ length: 31 }, () => ({ reps: 5 }));
    expect(sets).toHaveLength(31);

    const err = await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [{ name: 'Bench press', sets }],
      },
      deps,
    ).catch((e: unknown) => e);

    const m = expectValidationFailed(err);
    // The per-exercise bound produces a path inside the array.
    expect(m.issues?.some((i) => i.path === 'exercises.0.sets')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('(e) rejects a payload where a later exercise has 31 sets (non-first index)', async () => {
    const { deps, create } = buildSessionsDeps();

    const validExercise = { name: 'Warm-up', sets: [{ reps: 10 }] };
    const fatExercise = {
      name: 'Squat',
      sets: Array.from({ length: 31 }, () => ({ reps: 5 })),
    };

    const err = await logSession(
      USER_ID,
      {
        startedAt: '2026-01-10T08:00:00.000Z',
        exercises: [validExercise, fatExercise],
      },
      deps,
    ).catch((e: unknown) => e);

    const m = expectValidationFailed(err);
    expect(m.issues?.some((i) => i.path === 'exercises.1.sets')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  (f) logSession — boundary: exactly 50 exercises × 30 sets          */
/* ================================================================== */

describe('logSession — boundary acceptance (Requirements 12.2 + 12.3)', () => {
  it('(f) accepts a payload with exactly 50 exercises × 30 sets each', async () => {
    const { deps, create } = buildSessionsDeps();

    const sets = Array.from({ length: 30 }, () => ({ reps: 5 }));
    const exercises = Array.from({ length: 50 }, (_, i) => ({
      name: `Exercise ${i + 1}`,
      sets,
    }));
    expect(exercises).toHaveLength(50);
    expect(exercises[0]?.sets).toHaveLength(30);
    expect(exercises[49]?.sets).toHaveLength(30);

    // The repo echoes the stored row; any shape matching the domain
    // model is fine — this test only cares that the service didn't
    // reject the payload and handed it off to persistence.
    const stored: WorkoutSession = {
      id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad' as WorkoutSession['id'],
      userId: USER_ID as WorkoutSession['userId'],
      studioId: null,
      startedAt: '2026-01-10T08:00:00.000Z',
      durationMin: null,
      exercises,
      notes: null,
      createdAt: '2026-01-10T08:45:00.000Z',
    };
    create.mockResolvedValueOnce(stored);

    const result = await logSession(
      USER_ID,
      { startedAt: '2026-01-10T08:00:00.000Z', exercises },
      deps,
    );

    expect(result).toBe(stored);
    expect(create).toHaveBeenCalledTimes(1);
    // Confirm the repo received the full 50-exercise payload with
    // each exercise carrying its 30-set array.
    const call = create.mock.calls[0]?.[0];
    expect(call?.exercises).toHaveLength(50);
    expect(call?.exercises[0]?.sets).toHaveLength(30);
    expect(call?.exercises[49]?.sets).toHaveLength(30);
  });
});
