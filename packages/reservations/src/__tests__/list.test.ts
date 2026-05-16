/**
 * Unit tests for the class-listing use case (`listClasses`).
 *
 * Exercises every branch of {@link ../list.ts}:
 *   - Happy path: rows from the repo are mapped 1-to-1 into
 *     `ClassListing` items, `startsAt` / `createdAt` are serialised
 *     as ISO-8601 strings, and `remaining` is read from the counter
 *     (Req 7.1, 7.2).
 *   - Counter miss: a `null` return from the counter falls back to
 *     `row.capacity` (Req 7.2 — protects classes whose seed write in
 *     task 6.2 has not yet landed).
 *   - Negative counter clamp: a transient negative value from Redis
 *     (between a losing `DECR` and its compensating `INCR`) is
 *     clamped at 0 so `ClassWithRemainingSchema.nonnegative()` stays
 *     satisfied.
 *   - Inverted range (`to <= from`) → throws `range_inverted`.
 *   - Range span > 90 days → throws `range_too_large` (Req 7.3).
 *   - Malformed range (non-ISO / missing field) → throws
 *     `invalid_range` with a populated issue list.
 *   - Empty repo result → returns `[]` and does NOT touch the
 *     counter (avoids wasted Redis round-trips).
 *
 * The repo and counter are hand-rolled `vi.fn()` doubles so the
 * suite never reaches Drizzle or Redis. Matches the pattern used
 * by `@athlya/members`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    ClassListError,
    listClasses,
    type ClassListing,
    type ClassRepo,
    type ClassRow,
    type FindInRangeRange,
    type ListClassesDeps,
} from '../list.js';

import type { RemainingCounterReader } from '../counter.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const COACH_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad';
const CLASS_ID_A = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8a1';
const CLASS_ID_B = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8a2';

function makeRow(overrides: Partial<ClassRow> = {}): ClassRow {
    return {
        id: CLASS_ID_A,
        studioId: STUDIO_ID,
        coachId: COACH_ID,
        title: 'HIIT 6:30',
        startsAt: new Date('2026-02-03T06:30:00.000Z'),
        durationMin: 45,
        capacity: 20,
        version: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    };
}

/**
 * Build a fresh `ListClassesDeps` with `vi.fn()`-backed repo +
 * counter doubles. The helper also returns the raw mocks so tests
 * can assert on call counts and arguments.
 */
function buildDeps(): {
    deps: ListClassesDeps;
    findInRange: ReturnType<typeof vi.fn<ClassRepo['findInRange']>>;
    getRemaining: ReturnType<typeof vi.fn<RemainingCounterReader['getRemaining']>>;
} {
    const findInRange = vi.fn<ClassRepo['findInRange']>();
    const getRemaining = vi.fn<RemainingCounterReader['getRemaining']>();

    const deps: ListClassesDeps = {
        classRepo: { findInRange },
        counter: { getRemaining },
    };
    return { deps, findInRange, getRemaining };
}

/** Valid 7-day window used by the happy-path tests. */
const WINDOW_7D = {
    from: '2026-02-01T00:00:00.000Z',
    to: '2026-02-08T00:00:00.000Z',
} as const;

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('listClasses — happy path (Req 7.1, 7.2)', () => {
    it('returns rows mapped to ClassListing with counter-provided remaining', async () => {
        const rowA = makeRow({
            id: CLASS_ID_A,
            title: 'HIIT 6:30',
            startsAt: new Date('2026-02-03T06:30:00.000Z'),
            capacity: 20,
        });
        const rowB = makeRow({
            id: CLASS_ID_B,
            title: 'Yoga 18:00',
            startsAt: new Date('2026-02-05T18:00:00.000Z'),
            capacity: 15,
        });

        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([rowA, rowB]);
        // eslint-disable-next-line @typescript-eslint/require-await
        getRemaining.mockImplementation(async (classId) => {
            if (classId === CLASS_ID_A) return 7;
            if (classId === CLASS_ID_B) return 15;
            return null;
        });

        const result = await listClasses(STUDIO_ID, WINDOW_7D, deps);

        expect(result).toHaveLength(2);
        const [first, second] = result as [ClassListing, ClassListing];
        expect(first).toStrictEqual({
            id: CLASS_ID_A,
            studioId: STUDIO_ID,
            coachId: COACH_ID,
            title: 'HIIT 6:30',
            startsAt: '2026-02-03T06:30:00.000Z',
            durationMin: 45,
            capacity: 20,
            version: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            remaining: 7,
        });
        expect(second.remaining).toBe(15);

        // The repo receives the parsed Date pair, not the raw strings.
        expect(findInRange).toHaveBeenCalledTimes(1);
        const [calledStudioId, calledRange] = findInRange.mock.calls[0] as [
            string,
            FindInRangeRange,
        ];
        expect(calledStudioId).toBe(STUDIO_ID);
        expect(calledRange.from.toISOString()).toBe(WINDOW_7D.from);
        expect(calledRange.to.toISOString()).toBe(WINDOW_7D.to);

        expect(getRemaining).toHaveBeenCalledTimes(2);
    });

    it('preserves repo ordering (startsAt ASC) — the service does not re-sort', async () => {
        // The repo promises ASC order; the service should not second-guess it.
        // We pass rows in the order the repo returned them and assert the
        // output preserves that order even if the startsAt values are
        // out-of-order (defensive: the index guarantee is what counts).
        const rowA = makeRow({ id: CLASS_ID_A, startsAt: new Date('2026-02-03T06:30:00.000Z') });
        const rowB = makeRow({ id: CLASS_ID_B, startsAt: new Date('2026-02-02T06:30:00.000Z') });

        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([rowA, rowB]);
        getRemaining.mockResolvedValue(10);

        const result = await listClasses(STUDIO_ID, WINDOW_7D, deps);
        expect(result.map((c) => c.id)).toStrictEqual([CLASS_ID_A, CLASS_ID_B]);
    });

    it('preserves a null coachId', async () => {
        const row = makeRow({ coachId: null });
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([row]);
        getRemaining.mockResolvedValue(5);

        const [first] = await listClasses(STUDIO_ID, WINDOW_7D, deps);
        expect(first?.coachId).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/*  Counter fallbacks (Req 7.2)                                        */
/* ------------------------------------------------------------------ */

describe('listClasses — counter fallbacks (Req 7.2)', () => {
    it('falls back to capacity when the counter returns null (key not seeded yet)', async () => {
        const row = makeRow({ capacity: 20 });
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([row]);
        getRemaining.mockResolvedValue(null);

        const [first] = await listClasses(STUDIO_ID, WINDOW_7D, deps);
        expect(first?.remaining).toBe(20);
    });

    it('clamps a transient negative counter value to 0', async () => {
        // Algorithm 1 can leave the counter briefly negative between a
        // losing DECR and its compensating INCR. The public API must
        // never surface a negative value (violates the schema).
        const row = makeRow({ capacity: 20 });
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([row]);
        getRemaining.mockResolvedValue(-3);

        const [first] = await listClasses(STUDIO_ID, WINDOW_7D, deps);
        expect(first?.remaining).toBe(0);
    });

    it('accepts a zero remaining count without falling back', async () => {
        // `0 ?? capacity` must still evaluate to 0 (regression guard
        // against using `||` instead of `??`).
        const row = makeRow({ capacity: 20 });
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([row]);
        getRemaining.mockResolvedValue(0);

        const [first] = await listClasses(STUDIO_ID, WINDOW_7D, deps);
        expect(first?.remaining).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  Range validation (Req 7.3)                                         */
/* ------------------------------------------------------------------ */

describe('listClasses — range validation (Req 7.3)', () => {
    it('throws range_inverted when to <= from', async () => {
        const { deps, findInRange, getRemaining } = buildDeps();

        await expect(
            listClasses(
                STUDIO_ID,
                {
                    from: '2026-02-08T00:00:00.000Z',
                    to: '2026-02-01T00:00:00.000Z',
                },
                deps,
            ),
        ).rejects.toMatchObject({
            name: 'ClassListError',
            code: 'range_inverted',
        });

        expect(findInRange).not.toHaveBeenCalled();
        expect(getRemaining).not.toHaveBeenCalled();
    });

    it('throws range_inverted when to === from', async () => {
        const { deps } = buildDeps();
        await expect(
            listClasses(
                STUDIO_ID,
                {
                    from: '2026-02-01T00:00:00.000Z',
                    to: '2026-02-01T00:00:00.000Z',
                },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'range_inverted' });
    });

    it('throws range_too_large when the span exceeds 90 days', async () => {
        const { deps, findInRange, getRemaining } = buildDeps();

        // 91 days, one past the 90-day cap.
        await expect(
            listClasses(
                STUDIO_ID,
                {
                    from: '2026-01-01T00:00:00.000Z',
                    to: '2026-04-02T00:00:00.001Z',
                },
                deps,
            ),
        ).rejects.toMatchObject({
            name: 'ClassListError',
            code: 'range_too_large',
        });

        expect(findInRange).not.toHaveBeenCalled();
        expect(getRemaining).not.toHaveBeenCalled();
    });

    it('accepts a range exactly at the 90-day boundary', async () => {
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([]);
        getRemaining.mockResolvedValue(null);

        // Exactly 90 days → still valid per the `<=` comparison.
        const result = await listClasses(
            STUDIO_ID,
            {
                from: '2026-01-01T00:00:00.000Z',
                to: '2026-04-01T00:00:00.000Z',
            },
            deps,
        );
        expect(result).toStrictEqual([]);
        expect(findInRange).toHaveBeenCalledTimes(1);
    });

    it('throws invalid_range on a non-ISO-8601 string', async () => {
        const { deps } = buildDeps();

        await expect(
            listClasses(
                STUDIO_ID,
                { from: 'not-a-date', to: '2026-02-08T00:00:00.000Z' },
                deps,
            ),
        ).rejects.toSatisfy((err) => {
            if (!(err instanceof ClassListError)) return false;
            return err.code === 'invalid_range' && err.issues.length > 0;
        });
    });

    it('throws invalid_range when a field is missing', async () => {
        const { deps } = buildDeps();

        await expect(
            listClasses(STUDIO_ID, { from: '2026-02-01T00:00:00.000Z' }, deps),
        ).rejects.toMatchObject({
            name: 'ClassListError',
            code: 'invalid_range',
        });
    });

    it('rejects unknown fields via the schema strict() mode', async () => {
        const { deps } = buildDeps();

        await expect(
            listClasses(
                STUDIO_ID,
                {
                    from: '2026-02-01T00:00:00.000Z',
                    to: '2026-02-08T00:00:00.000Z',
                    evil: 'payload',
                },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'invalid_range' });
    });

    it('prefers range_inverted over range_too_large when both fail', async () => {
        // An inverted span that, were it non-inverted, would exceed 90
        // days. We want to tell the client their range is backwards,
        // not that it's "too long" — chasing the 90-day cap here would
        // send them down the wrong fix path.
        const { deps } = buildDeps();
        await expect(
            listClasses(
                STUDIO_ID,
                {
                    from: '2026-06-01T00:00:00.000Z',
                    to: '2026-01-01T00:00:00.000Z',
                },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'range_inverted' });
    });
});

/* ------------------------------------------------------------------ */
/*  Empty result                                                       */
/* ------------------------------------------------------------------ */

describe('listClasses — empty result', () => {
    it('returns [] and does not touch the counter when the repo is empty', async () => {
        const { deps, findInRange, getRemaining } = buildDeps();
        findInRange.mockResolvedValue([]);

        const result = await listClasses(STUDIO_ID, WINDOW_7D, deps);

        expect(result).toStrictEqual([]);
        expect(findInRange).toHaveBeenCalledTimes(1);
        expect(getRemaining).not.toHaveBeenCalled();
    });
});
