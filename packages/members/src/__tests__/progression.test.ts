/**
 * Unit + property tests for `@athlya/members/progression` (task 22.1).
 */

import { ProgressionResponseSchema } from '@athlya/shared/schemas/api';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  EPLEY_MAX_REPS,
  PROGRESSION_MAX_EXERCISES,
  PROGRESSION_SESSION_LIMIT,
  computeProgression,
  estimateOneRepMax,
  exerciseKey,
  getProgression,
  progressionWindowBounds,
  type ProgressionRepo,
} from '../progression.js';
import { MembersError } from '../service.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
/** Thursday 2026-10-15, 14:30 UTC. */
const NOW = Date.parse('2026-10-15T14:30:00.000Z');

let counter = 0;
function nextId(): string {
  counter += 1;
  return `018f3c11-4e2d-7b53-9a0c-${counter.toString(16).padStart(12, '0')}`;
}

interface SetInput {
  reps: number;
  weightKg?: number;
}

function session(startedAt: string, exercises: Array<{ name: string; sets: SetInput[] }>) {
  return {
    id: nextId(),
    userId: USER_ID,
    studioId: null,
    startedAt,
    durationMin: 60,
    exercises,
    notes: null,
    createdAt: startedAt,
  };
}

/* ------------------------------------------------------------------ */
/*  estimateOneRepMax                                                  */
/* ------------------------------------------------------------------ */

describe('estimateOneRepMax (Epley)', () => {
  it('returns the weight itself for a single', () => {
    expect(estimateOneRepMax(140, 1)).toBe(140);
  });

  it('applies w × (1 + r / 30) for 2 ≤ r ≤ 12', () => {
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(116.6667, 4);
    expect(estimateOneRepMax(60, 10)).toBeCloseTo(80, 10);
    expect(estimateOneRepMax(50, EPLEY_MAX_REPS)).toBeCloseTo(70, 10);
  });

  it('ignores sets without a positive weight, without reps, or above the rep cap', () => {
    expect(estimateOneRepMax(undefined, 5)).toBeNull();
    expect(estimateOneRepMax(0, 5)).toBeNull();
    expect(estimateOneRepMax(100, 0)).toBeNull();
    expect(estimateOneRepMax(100, EPLEY_MAX_REPS + 1)).toBeNull();
  });

  it('is monotonic in weight and in reps (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.integer({ min: 1, max: EPLEY_MAX_REPS - 1 }),
        (weight, extra, reps) => {
          const base = estimateOneRepMax(weight, reps) ?? Number.NaN;
          expect(estimateOneRepMax(weight + extra, reps)).toBeGreaterThanOrEqual(base);
          expect(estimateOneRepMax(weight, reps + 1)).toBeGreaterThan(base);
          expect(base).toBeGreaterThanOrEqual(weight);
        },
      ),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  exerciseKey / window bounds                                        */
/* ------------------------------------------------------------------ */

describe('exerciseKey', () => {
  it('groups case and whitespace variants together', () => {
    expect(exerciseKey('  Back   Squat ')).toBe('back squat');
    expect(exerciseKey('back squat')).toBe('back squat');
  });
});

describe('progressionWindowBounds', () => {
  it('covers whole UTC days ending with today', () => {
    const { from, to } = progressionWindowBounds(30, NOW);
    expect(to.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(from.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('is stable within a UTC day', () => {
    const a = progressionWindowBounds(90, Date.parse('2026-10-15T00:00:00.000Z'));
    const b = progressionWindowBounds(90, Date.parse('2026-10-15T23:59:59.999Z'));
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ */
/*  computeProgression                                                 */
/* ------------------------------------------------------------------ */

describe('computeProgression', () => {
  const rows = [
    session('2026-10-01T08:00:00.000Z', [
      {
        name: 'Back squat',
        sets: [
          { reps: 5, weightKg: 100 },
          { reps: 3, weightKg: 110 },
        ],
      },
      { name: 'Pull-up', sets: [{ reps: 10 }] },
    ]),
    session('2026-10-01T18:00:00.000Z', [
      { name: 'back squat', sets: [{ reps: 1, weightKg: 130 }] },
    ]),
    session('2026-10-08T08:00:00.000Z', [
      { name: 'Back Squat', sets: [{ reps: 15, weightKg: 60 }] },
    ]),
  ];

  const result = computeProgression(rows, { windowDays: 30, now: NOW });

  it('matches the shared response schema', () => {
    expect(ProgressionResponseSchema.safeParse(result).success).toBe(true);
  });

  it('sums volume per day and keeps the best estimated 1RM', () => {
    const squat = result.exercises.find((e) => e.key === 'back squat');
    expect(squat).toBeDefined();
    expect(squat?.name).toBe('Back Squat');
    expect(squat?.sessionCount).toBe(3);
    expect(squat?.points).toEqual([
      // 5×100 + 3×110 + 1×130 = 960; best = max(116.67, 121, 130)
      { date: '2026-10-01', volumeKg: 960, estimatedOneRepMaxKg: 130 },
      // 15 reps exceeds the Epley cap: volume counts, no estimate.
      { date: '2026-10-08', volumeKg: 900, estimatedOneRepMaxKg: null },
    ]);
    expect(squat?.totalVolumeKg).toBe(1860);
    expect(squat?.bestEstimatedOneRepMaxKg).toBe(130);
  });

  it('keeps bodyweight exercises with zero volume and no estimate', () => {
    const pullUp = result.exercises.find((e) => e.key === 'pull-up');
    expect(pullUp).toMatchObject({
      sessionCount: 1,
      totalVolumeKg: 0,
      bestEstimatedOneRepMaxKg: null,
    });
  });

  it('ranks exercises by session count', () => {
    expect(result.exercises.map((e) => e.key)).toEqual(['back squat', 'pull-up']);
  });

  it('zero-fills ISO weeks across the window', () => {
    expect(result.weeklyFrequency[0]?.weekStart).toBe('2026-09-14');
    expect(result.weeklyFrequency.at(-1)?.weekStart).toBe('2026-10-12');
    const byWeek = Object.fromEntries(result.weeklyFrequency.map((w) => [w.weekStart, w.sessions]));
    expect(byWeek['2026-09-28']).toBe(2);
    expect(byWeek['2026-10-05']).toBe(1);
    expect(byWeek['2026-09-21']).toBe(0);
  });

  it('reports totals and window bounds', () => {
    expect(result.totals).toEqual({ sessions: 3, volumeKg: 1860 });
    expect(result.from).toBe('2026-09-16T00:00:00.000Z');
    expect(result.to).toBe('2026-10-16T00:00:00.000Z');
    expect(result.truncated).toBe(false);
    expect(result.skippedSessions).toBe(0);
  });

  it('skips rows that fail WorkoutSessionSchema instead of throwing', () => {
    const bad = {
      ...session('2026-10-02T08:00:00.000Z', []),
      exercises: [{ name: 'X', sets: [{ reps: -1 }] }],
    };
    const out = computeProgression([...rows, bad, null, 'garbage'], { windowDays: 30, now: NOW });
    expect(out.skippedSessions).toBe(3);
    expect(out.totals.sessions).toBe(3);
  });

  it('stays schema-valid when a tiny weight rounds its estimate to 0', () => {
    const light = session('2026-10-10T08:00:00.000Z', [
      { name: 'Band pull-apart', sets: [{ reps: 1, weightKg: 0.01 }] },
    ]);
    const out = computeProgression([light], { windowDays: 30, now: NOW });
    expect(out.exercises[0]?.bestEstimatedOneRepMaxKg).toBe(0);
    expect(ProgressionResponseSchema.safeParse(out).success).toBe(true);
  });

  it('ignores sessions outside the window', () => {
    const old = session('2026-09-15T23:59:59.999Z', [
      { name: 'Deadlift', sets: [{ reps: 5, weightKg: 200 }] },
    ]);
    const future = session('2026-10-16T00:00:00.000Z', [
      { name: 'Deadlift', sets: [{ reps: 5, weightKg: 200 }] },
    ]);
    const out = computeProgression([old, future], { windowDays: 30, now: NOW });
    expect(out.totals.sessions).toBe(0);
    expect(out.exercises).toEqual([]);
  });

  it(`caps the exercise list at ${PROGRESSION_MAX_EXERCISES}`, () => {
    const many = session(
      '2026-10-10T08:00:00.000Z',
      Array.from({ length: 30 }, (_, i) => ({
        name: `Move ${i}`,
        sets: [{ reps: 5, weightKg: i + 1 }],
      })),
    );
    const out = computeProgression([many], { windowDays: 30, now: NOW });
    expect(out.exercises).toHaveLength(PROGRESSION_MAX_EXERCISES);
    // Equal session counts: heavier volume ranks first.
    expect(out.exercises[0]?.name).toBe('Move 29');
  });

  it('builds 53 or 54 weekly buckets for a 365-day window', () => {
    const out = computeProgression([], { windowDays: 365, now: NOW });
    expect(out.weeklyFrequency.length).toBeGreaterThanOrEqual(53);
    expect(out.weeklyFrequency.length).toBeLessThanOrEqual(54);
  });
});

/* ------------------------------------------------------------------ */
/*  Properties                                                         */
/* ------------------------------------------------------------------ */

const WINDOW_START = Date.parse('2026-07-18T00:00:00.000Z'); // 90-day window start for NOW
const WINDOW_END = Date.parse('2026-10-16T00:00:00.000Z');

const setArb = fc.record(
  {
    reps: fc.integer({ min: 0, max: 30 }),
    weightKg: fc.integer({ min: 0, max: 3000 }).map((n) => n / 10),
  },
  { requiredKeys: ['reps'] },
);

const sessionArb = fc
  .record({
    at: fc.integer({ min: WINDOW_START - 20 * 86_400_000, max: WINDOW_END + 20 * 86_400_000 }),
    exercises: fc.array(
      fc.record({
        name: fc.constantFrom('Bench press', 'bench press', 'Row', 'Squat', 'Plank'),
        sets: fc.array(setArb, { maxLength: 6 }),
      }),
      { maxLength: 5 },
    ),
  })
  .map(({ at, exercises }) => session(new Date(at).toISOString(), exercises));

describe('computeProgression properties', () => {
  it('weekly frequency sums to the in-window session count', () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { maxLength: 40 }), (rows) => {
        const out = computeProgression(rows, { windowDays: 90, now: NOW });
        const inWindow = rows.filter((r) => {
          const at = Date.parse(r.startedAt);
          return at >= WINDOW_START && at < WINDOW_END;
        }).length;
        expect(out.totals.sessions).toBe(inWindow);
        expect(out.weeklyFrequency.reduce((sum, w) => sum + w.sessions, 0)).toBe(inWindow);
      }),
    );
  });

  it('per-exercise volume equals the sum of its points, and points are sorted', () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { maxLength: 40 }), (rows) => {
        const out = computeProgression(rows, { windowDays: 90, now: NOW });
        for (const exercise of out.exercises) {
          const pointSum = exercise.points.reduce((sum, p) => sum + p.volumeKg, 0);
          // Each point is rounded to 0.1 kg independently.
          expect(Math.abs(pointSum - exercise.totalVolumeKg)).toBeLessThanOrEqual(
            0.05 * (exercise.points.length + 1),
          );
          const dates = exercise.points.map((p) => p.date);
          expect([...dates].sort()).toEqual(dates);
          const best = exercise.points.reduce<number | null>(
            (max, p) =>
              p.estimatedOneRepMaxKg === null ? max : Math.max(max ?? 0, p.estimatedOneRepMaxKg),
            null,
          );
          expect(exercise.bestEstimatedOneRepMaxKg).toBe(best);
        }
        expect(ProgressionResponseSchema.safeParse(out).success).toBe(true);
      }),
    );
  });

  it('is independent of row order', () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { maxLength: 20 }), (rows) => {
        const forward = computeProgression(rows, { windowDays: 90, now: NOW });
        const reversed = computeProgression([...rows].reverse(), { windowDays: 90, now: NOW });
        expect(reversed.totals).toEqual(forward.totals);
        expect(reversed.weeklyFrequency).toEqual(forward.weeklyFrequency);
        expect(reversed.exercises.map((e) => e.points)).toEqual(
          forward.exercises.map((e) => e.points),
        );
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  getProgression                                                     */
/* ------------------------------------------------------------------ */

describe('getProgression', () => {
  it('reads the window bounds through the repo and aggregates the rows', async () => {
    const listInWindow = vi
      .fn<ProgressionRepo['listInWindow']>()
      .mockResolvedValue([
        session('2026-10-15T08:00:00.000Z', [
          { name: 'Squat', sets: [{ reps: 5, weightKg: 100 }] },
        ]),
      ]);
    const out = await getProgression(USER_ID, 30, { repo: { listInWindow }, now: () => NOW });
    expect(listInWindow).toHaveBeenCalledWith(USER_ID, {
      from: new Date('2026-09-16T00:00:00.000Z'),
      to: new Date('2026-10-16T00:00:00.000Z'),
      limit: PROGRESSION_SESSION_LIMIT + 1,
    });
    expect(out.totals.sessions).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('flags truncation and keeps the newest rows when the repo returns one row too many', async () => {
    // Newest first, as the repo returns them; each row has its own exercise.
    const rows = Array.from({ length: PROGRESSION_SESSION_LIMIT + 1 }, (_, i) =>
      session(new Date(NOW - i * 60_000).toISOString(), [
        { name: `Move ${i}`, sets: [{ reps: 1, weightKg: 1 }] },
      ]),
    );
    const out = await getProgression(USER_ID, 365, {
      repo: { listInWindow: () => Promise.resolve(rows) },
      now: () => NOW,
    });
    expect(out.truncated).toBe(true);
    expect(out.totals.sessions).toBe(PROGRESSION_SESSION_LIMIT);
    // The volume of the dropped (oldest) row is missing from the total.
    expect(out.totals.volumeKg).toBe(PROGRESSION_SESSION_LIMIT);
    const computed = computeProgression(rows.slice(0, PROGRESSION_SESSION_LIMIT), {
      windowDays: 365,
      now: NOW,
    });
    expect(out.exercises).toEqual(computed.exercises);
    expect(out.exercises.some((e) => e.key === `move ${PROGRESSION_SESSION_LIMIT}`)).toBe(false);
  });

  it('rejects a window outside 30 / 90 / 365 before any I/O', async () => {
    const listInWindow = vi.fn<ProgressionRepo['listInWindow']>();
    await expect(getProgression(USER_ID, 7, { repo: { listInWindow } })).rejects.toBeInstanceOf(
      MembersError,
    );
    expect(listInWindow).not.toHaveBeenCalled();
  });
});
