/**
 * Unit tests for `@athlya/reservations/update`.
 *
 * Covers the admin-only class update use case added in task 6.3:
 *
 *   - role gate runs before validation and before any repo call
 *     (Requirement 6.5),
 *   - happy path bumps `version` via the repo's optimistic UPDATE and
 *     skips the Redis counter reset when `capacity` is unchanged
 *     (Requirement 6.6, 6.7),
 *   - 0-rows-affected from the repo surfaces as `conflict`
 *     (Requirement 6.6),
 *   - a `capacity` change triggers `counter.reset(classId, capacity)`
 *     (Requirement 6.7),
 *   - a missing row surfaces as `not_found` (prevents a `conflict`
 *     false positive when the row simply doesn't exist).
 *
 * The repo and counter are hand-rolled `vi.fn()` doubles so the tests
 * never touch Drizzle, Postgres or Upstash — they exercise the service
 * layer in pure isolation, matching the style used across the rest of
 * the monorepo (`@athlya/members/service` in particular).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  updateClass,
  UpdateClassError,
  type ClassCounter,
  type ClassRepo,
  type UpdateClassDeps,
  type UpdateClassFields,
} from '../update.js';

import type { ClassRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const COACH_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad';

/**
 * Canonical "existing class row" used as the baseline for every test.
 * `startsAt` is a `Date` because that's what Drizzle's `timestamp`
 * column with `mode: 'date'` returns (see
 * `packages/db/src/schema/classes.ts`).
 */
const BASE_ROW: ClassRow = {
  id: CLASS_ID,
  studioId: STUDIO_ID,
  coachId: COACH_ID,
  title: 'HIIT morning',
  description: null,
  startsAt: new Date('2026-03-01T09:00:00.000Z'),
  durationMin: 45,
  capacity: 20,
  version: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

/**
 * Build a fresh {@link UpdateClassDeps} with `vi.fn()` doubles for
 * both the repo and the counter. Returning the individual mocks lets
 * each test assert on their call history without reaching into
 * `deps.classRepo`.
 */
function buildDeps(): {
  deps: UpdateClassDeps;
  findById: Mock<ClassRepo['findById']>;
  updateClassOptimistic: Mock<ClassRepo['updateClassOptimistic']>;
  reset: Mock<ClassCounter['reset']>;
} {
  const findById = vi.fn<ClassRepo['findById']>();
  const updateClassOptimistic = vi.fn<ClassRepo['updateClassOptimistic']>();
  const reset = vi.fn<ClassCounter['reset']>();

  const classRepo: ClassRepo = {
    findById,
    updateClassOptimistic,
  };
  const counter: ClassCounter = { reset };

  return {
    deps: { classRepo, counter },
    findById,
    updateClassOptimistic,
    reset,
  };
}

/* ------------------------------------------------------------------ */
/*  Role gate — Requirement 6.5                                        */
/* ------------------------------------------------------------------ */

describe('updateClass — role gate', () => {
  it('rejects a member with forbidden, without touching the repo or validating the payload', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    const err = await updateClass(
      STUDIO_ID,
      CLASS_ID,
      // Deliberately *invalid* payload: if the role gate were
      // ever bypassed, validation would fail first and we'd see
      // `validation_failed` instead of `forbidden`. Asserting
      // `forbidden` here therefore proves the gate runs first.
      { capacity: -999 },
      'member',
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpdateClassError);
    expect((err as UpdateClassError).code).toBe('forbidden');
    expect(findById).not.toHaveBeenCalled();
    expect(updateClassOptimistic).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('rejects a coach with forbidden (coaches may read but not edit classes)', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    const err = await updateClass(
      STUDIO_ID,
      CLASS_ID,
      { version: 3, title: 'Updated' },
      'coach',
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpdateClassError);
    expect((err as UpdateClassError).code).toBe('forbidden');
    expect(findById).not.toHaveBeenCalled();
    expect(updateClassOptimistic).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Happy path — Requirement 6.6, 6.7                                  */
/* ------------------------------------------------------------------ */

describe('updateClass — happy path', () => {
  it('runs the optimistic UPDATE and returns the new row when version matches', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(BASE_ROW);
    const updatedRow: ClassRow = {
      ...BASE_ROW,
      title: 'HIIT morning (renamed)',
      version: BASE_ROW.version + 1,
    };
    updateClassOptimistic.mockResolvedValueOnce(updatedRow);

    const result = await updateClass(
      STUDIO_ID,
      CLASS_ID,
      { version: 3, title: 'HIIT morning (renamed)' },
      'admin',
      deps,
    );

    expect(result).toEqual(updatedRow);
    expect(findById).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, CLASS_ID);

    // The repo was called with the `version` stripped off — the
    // guard is a separate argument, never a patch column.
    const expectedFields: UpdateClassFields = {
      title: 'HIIT morning (renamed)',
    };
    expect(updateClassOptimistic).toHaveBeenCalledExactlyOnceWith(
      STUDIO_ID,
      CLASS_ID,
      expectedFields,
      3,
    );

    // Capacity was not in the patch, so the Redis counter is left
    // alone. Requirement 6.7 only asks to "recompute Redis counter
    // if capacity changed".
    expect(reset).not.toHaveBeenCalled();
  });

  it('skips counter.reset when capacity is echoed unchanged', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(BASE_ROW);
    updateClassOptimistic.mockResolvedValueOnce({
      ...BASE_ROW,
      version: BASE_ROW.version + 1,
    });

    await updateClass(
      STUDIO_ID,
      CLASS_ID,
      // Capacity is present but equal to the existing value —
      // the service must treat this as a no-op for the counter.
      { version: 3, capacity: BASE_ROW.capacity, title: 'Rebranded' },
      'admin',
      deps,
    );

    expect(reset).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Optimistic-lock conflict — Requirement 6.6                         */
/* ------------------------------------------------------------------ */

describe('updateClass — optimistic-lock conflict', () => {
  it('surfaces `conflict` when the repo reports 0 rows affected', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(BASE_ROW);
    // Simulate the DB returning 0 affected rows because the
    // caller's `expectedVersion` was stale.
    updateClassOptimistic.mockResolvedValueOnce(null);

    const err = await updateClass(
      STUDIO_ID,
      CLASS_ID,
      // Caller echoes version 2 while the row is at 3.
      { version: 2, title: 'Stale write' },
      'admin',
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpdateClassError);
    expect((err as UpdateClassError).code).toBe('conflict');

    // The repo was still called — we need the UPDATE attempt to
    // prove the conflict. Only the Redis side-effect is skipped.
    expect(updateClassOptimistic).toHaveBeenCalledExactlyOnceWith(
      STUDIO_ID,
      CLASS_ID,
      { title: 'Stale write' },
      2,
    );
    expect(reset).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Capacity change — Requirement 6.7                                  */
/* ------------------------------------------------------------------ */

describe('updateClass — capacity change', () => {
  it('resets the Redis counter to the new capacity after a successful UPDATE', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(BASE_ROW);
    const NEW_CAPACITY = 30;
    updateClassOptimistic.mockResolvedValueOnce({
      ...BASE_ROW,
      capacity: NEW_CAPACITY,
      version: BASE_ROW.version + 1,
    });

    await updateClass(STUDIO_ID, CLASS_ID, { version: 3, capacity: NEW_CAPACITY }, 'admin', deps);

    expect(reset).toHaveBeenCalledExactlyOnceWith(CLASS_ID, NEW_CAPACITY);
  });

  it('does not reset the counter when the DB UPDATE reports a conflict', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(BASE_ROW);
    updateClassOptimistic.mockResolvedValueOnce(null);

    await updateClass(STUDIO_ID, CLASS_ID, { version: 2, capacity: 40 }, 'admin', deps).catch(
      () => {
        /* conflict is expected; swallowed here because the
         * counter assertion below is the point of the test. */
      },
    );

    expect(reset).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Missing row                                                        */
/* ------------------------------------------------------------------ */

describe('updateClass — not found', () => {
  it('surfaces `not_found` when the class does not exist and never calls UPDATE', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    findById.mockResolvedValueOnce(null);

    const err = await updateClass(
      STUDIO_ID,
      CLASS_ID,
      { version: 0, title: 'Any' },
      'admin',
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpdateClassError);
    expect((err as UpdateClassError).code).toBe('not_found');
    expect(findById).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, CLASS_ID);
    expect(updateClassOptimistic).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('surfaces `not_found` when a class belongs to a different studio (cross-tenant security check)', async () => {
    const { deps, findById, updateClassOptimistic, reset } = buildDeps();

    const DIFFERENT_STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ff';
    findById.mockResolvedValueOnce(null);

    const err = await updateClass(
      CLASS_ID,
      DIFFERENT_STUDIO_ID,
      { version: 3, title: 'Hacked' },
      'admin',
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpdateClassError);
    expect((err as UpdateClassError).code).toBe('not_found');
    expect(findById).toHaveBeenCalledExactlyOnceWith(CLASS_ID, DIFFERENT_STUDIO_ID);
    expect(updateClassOptimistic).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});
