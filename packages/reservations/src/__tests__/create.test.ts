/**
 * Unit tests for `@athlya/reservations/create`.
 *
 * Covers every acceptance criterion of Requirement 6.1–6.4 from the
 * Athlya spec:
 *
 *   - 6.1 — a well-formed payload is persisted with `version = 0`
 *           and the remaining-seats counter is seeded to `capacity`.
 *   - 6.2 — `capacity = 0` and `capacity = 501` are rejected with
 *           `validation_failed`.
 *   - 6.3 — `durationMin = 4` and `durationMin = 481` are rejected
 *           with `validation_failed`.
 *   - 6.4 — `startsAt` at or before `now` is rejected with
 *           `class_in_past`.
 *
 * The repo and counter are `vi.fn()` doubles; the injected `now()`
 * pins wall-clock time so the "in the past" branch is deterministic.
 */

import { StudioId, UserId } from '@athlya/shared/ids';
import { describe, expect, it, vi } from 'vitest';


import {
    CreateClassError,
    createClass,
    type ClassRepo,
    type CreateClassDeps,
    type CreateClassInput,
    type CreateClassRepoInput,
    type RemainingCounterWriter,
} from '../create.js';

import type { ClassRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const STUDIO_ID = StudioId('11111111-1111-4111-8111-111111111111');
const COACH_ID = UserId('22222222-2222-4222-8222-222222222222');
const CLASS_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Fixed clock used across the suite — 2026-06-01T00:00:00Z. All
 * "valid future" timestamps are one hour after this and all "past"
 * timestamps are one hour before.
 */
const FIXED_NOW_MS = Date.parse('2026-06-01T00:00:00.000Z');
const FUTURE_ISO = '2026-06-01T01:00:00.000Z';
const PAST_ISO = '2026-05-31T23:00:00.000Z';

/**
 * Default happy-path input. Individual tests override single fields to
 * exercise the boundary checks without rebuilding the whole object.
 */
function validInput(overrides: Partial<CreateClassInput> = {}): unknown {
    return {
        title: 'Yoga Flow',
        startsAt: FUTURE_ISO,
        durationMin: 60,
        capacity: 20,
        ...overrides,
    };
}

/**
 * Build a row that looks like what the DB would return after inserting
 * the given `input`. `id` and `createdAt` are repo-side concerns; the
 * rest is echoed straight back.
 */
function rowFor(input: CreateClassRepoInput): ClassRow {
    return {
        id: CLASS_ID,
        studioId: input.studioId,
        coachId: input.coachId !== undefined ? (input.coachId) : null,
        title: input.title,
        startsAt: new Date(input.startsAt),
        durationMin: input.durationMin,
        capacity: input.capacity,
        version: 0,
        createdAt: new Date(FIXED_NOW_MS),
        deletedAt: null,
    };
}

/** Wire up fresh mocks + a pinned clock. */
function makeDeps(): {
    deps: CreateClassDeps;
    repoCreate: ReturnType<typeof vi.fn>;
    counterReset: ReturnType<typeof vi.fn>;
} {
    const repoCreate = vi
        .fn<ClassRepo['createClass']>()
        .mockImplementation((input) => Promise.resolve(rowFor(input)));
    const counterReset = vi
        .fn<RemainingCounterWriter['reset']>()
        .mockResolvedValue(undefined);
    const repo: ClassRepo = { createClass: repoCreate };
    const counter: RemainingCounterWriter = { reset: counterReset };
    const deps: CreateClassDeps = {
        classRepo: repo,
        counter,
        now: () => FIXED_NOW_MS,
    };
    return { deps, repoCreate, counterReset };
}

/** Invoke `createClass` and capture the thrown error (or `undefined`). */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
    try {
        await fn();
        return undefined;
    } catch (err) {
        return err;
    }
}

/* ------------------------------------------------------------------ */
/*  Validation: capacity bounds (Requirement 6.2)                      */
/* ------------------------------------------------------------------ */

describe('createClass capacity bounds (Req 6.2)', () => {
    it('rejects capacity = 0 with validation_failed', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ capacity: 0 }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('validation_failed');
            expect(err.issues.length).toBeGreaterThan(0);
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('rejects capacity = 501 with validation_failed', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ capacity: 501 }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('validation_failed');
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('accepts capacity = 1 (lower bound) and capacity = 500 (upper bound)', async () => {
        for (const capacity of [1, 500] as const) {
            const { deps, repoCreate, counterReset } = makeDeps();
            await expect(
                createClass(STUDIO_ID, validInput({ capacity }), deps),
            ).resolves.toBeDefined();
            expect(repoCreate).toHaveBeenCalledTimes(1);
            expect(counterReset).toHaveBeenCalledWith(CLASS_ID, capacity);
        }
    });
});

/* ------------------------------------------------------------------ */
/*  Validation: duration bounds (Requirement 6.3)                      */
/* ------------------------------------------------------------------ */

describe('createClass durationMin bounds (Req 6.3)', () => {
    it('rejects durationMin = 4 with validation_failed', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ durationMin: 4 }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('validation_failed');
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('rejects durationMin = 481 with validation_failed', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ durationMin: 481 }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('validation_failed');
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('accepts durationMin = 5 (lower bound) and durationMin = 480 (upper bound)', async () => {
        for (const durationMin of [5, 480] as const) {
            const { deps, repoCreate, counterReset } = makeDeps();
            await expect(
                createClass(STUDIO_ID, validInput({ durationMin }), deps),
            ).resolves.toBeDefined();
            expect(repoCreate).toHaveBeenCalledTimes(1);
            expect(counterReset).toHaveBeenCalledTimes(1);
        }
    });
});

/* ------------------------------------------------------------------ */
/*  Validation: startsAt in the past (Requirement 6.4)                 */
/* ------------------------------------------------------------------ */

describe('createClass startsAt rule (Req 6.4)', () => {
    it('rejects a startsAt strictly in the past with class_in_past', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ startsAt: PAST_ISO }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('class_in_past');
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('rejects a startsAt equal to now with class_in_past', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const nowIso = new Date(FIXED_NOW_MS).toISOString();
        const err = await caught(() =>
            createClass(STUDIO_ID, validInput({ startsAt: nowIso }), deps),
        );
        expect(err).toBeInstanceOf(CreateClassError);
        if (err instanceof CreateClassError) {
            expect(err.code).toBe('class_in_past');
        }
        expect(repoCreate).not.toHaveBeenCalled();
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('accepts a startsAt one millisecond after now', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const futureIso = new Date(FIXED_NOW_MS + 1).toISOString();
        await expect(
            createClass(STUDIO_ID, validInput({ startsAt: futureIso }), deps),
        ).resolves.toBeDefined();
        expect(repoCreate).toHaveBeenCalledTimes(1);
        expect(counterReset).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ */
/*  Happy path (Requirement 6.1)                                       */
/* ------------------------------------------------------------------ */

describe('createClass happy path (Req 6.1)', () => {
    it('calls ClassRepo.createClass with version = 0 and the supplied studioId', async () => {
        const { deps, repoCreate } = makeDeps();

        await createClass(STUDIO_ID, validInput(), deps);

        expect(repoCreate).toHaveBeenCalledTimes(1);
        const [call] = repoCreate.mock.calls[0] as [CreateClassRepoInput];
        expect(call.version).toBe(0);
        expect(call.studioId).toBe(STUDIO_ID);
        expect(call.title).toBe('Yoga Flow');
        expect(call.startsAt).toBe(FUTURE_ISO);
        expect(call.durationMin).toBe(60);
        expect(call.capacity).toBe(20);
    });

    it('seeds the remaining-seats counter with row.id and row.capacity', async () => {
        const { deps, counterReset } = makeDeps();

        const row = await createClass(STUDIO_ID, validInput({ capacity: 42 }), deps);

        expect(counterReset).toHaveBeenCalledTimes(1);
        expect(counterReset).toHaveBeenCalledWith(row.id, 42);
        expect(row.id).toBe(CLASS_ID);
    });

    it('invokes repo.createClass BEFORE counter.reset', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        const order: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        repoCreate.mockImplementationOnce((input: CreateClassRepoInput) => {
            order.push('repo');
            return Promise.resolve(rowFor(input));
        });
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        counterReset.mockImplementationOnce(() => {
            order.push('counter');
            return Promise.resolve();
        });

        await createClass(STUDIO_ID, validInput(), deps);

        expect(order).toStrictEqual(['repo', 'counter']);
    });

    it('does not seed the counter when the repo insert rejects', async () => {
        const { deps, repoCreate, counterReset } = makeDeps();
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        repoCreate.mockImplementationOnce(() => Promise.reject(new Error('db down')));

        await expect(createClass(STUDIO_ID, validInput(), deps)).rejects.toThrow('db down');

        expect(repoCreate).toHaveBeenCalledTimes(1);
        expect(counterReset).not.toHaveBeenCalled();
    });

    it('passes coachId through when provided', async () => {
        const { deps, repoCreate } = makeDeps();

        await createClass(STUDIO_ID, validInput({ coachId: COACH_ID }), deps);

        const [call] = repoCreate.mock.calls[0] as [CreateClassRepoInput];
        expect(call.coachId).toBe(COACH_ID);
    });

    it('omits coachId when not provided (classes without a coach are legal)', async () => {
        const { deps, repoCreate } = makeDeps();

        await createClass(STUDIO_ID, validInput(), deps);

        const [call] = repoCreate.mock.calls[0] as [CreateClassRepoInput];
        expect('coachId' in call).toBe(false);
    });
});
