/**
 * Unit + property tests for the minimised coach context (task 21.1).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COACH_EXERCISE_NAME_MAX,
  COACH_MASK,
  COACH_MAX_EXERCISES_PER_SESSION,
  COACH_MAX_RANKED_EXERCISES,
  COACH_MAX_SESSIONS,
  buildCoachContext,
  sanitizeExerciseName,
} from '../src/context.js';
import { buildCoachPrompt } from '../src/prompt.js';

import { NOW, STUDIO_ID, USER_ID, session } from './fixtures.js';

describe('sanitizeExerciseName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeExerciseName('  Back   squat ')).toBe('Back squat');
  });

  it('masks e-mail addresses and long digit runs', () => {
    expect(sanitizeExerciseName('curl jane.doe@example.com')).toBe(`curl ${COACH_MASK}`);
    expect(sanitizeExerciseName('call 0612345678')).toBe(`call ${COACH_MASK}`);
    expect(sanitizeExerciseName('5x5 squat 2026')).toBe('5x5 squat 2026');
  });

  it('drops control characters and cuts long names', () => {
    expect(sanitizeExerciseName('row\u0000\nhigh')).toBe('row high');
    expect(sanitizeExerciseName('a'.repeat(200))).toHaveLength(COACH_EXERCISE_NAME_MAX);
  });

  it('stays linear on long adversarial input (no ReDoS)', () => {
    const inputs = [
      '!'.repeat(200_000),
      `${'a'.repeat(100_000)}@`,
      '@'.repeat(100_000),
      `${'1'.repeat(100_000)}x`,
      ' \u0001'.repeat(100_000),
    ];
    const started = performance.now();
    for (const input of inputs) {
      expect([...sanitizeExerciseName(input)].length).toBeLessThanOrEqual(COACH_EXERCISE_NAME_MAX);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('never returns an empty string', () => {
    expect(sanitizeExerciseName('\u0001')).toBe(COACH_MASK);
  });
});

describe('buildCoachContext', () => {
  const rows = [
    session(
      '2026-10-14T18:00:00.000Z',
      [
        {
          name: 'Back squat',
          sets: [
            { reps: 5, weightKg: 100 },
            { reps: 5, weightKg: 105 },
          ],
        },
        { name: 'Pull-up', sets: [{ reps: 8 }] },
      ],
      { notes: 'Felt great, call me on 0612345678 — Jane' },
    ),
    session('2026-10-10T07:00:00.000Z', [
      { name: 'back squat', sets: [{ reps: 5, weightKg: 95 }] },
    ]),
    // Outside the 30-day window.
    session('2026-08-01T07:00:00.000Z', [{ name: 'Deadlift', sets: [{ reps: 3, weightKg: 150 }] }]),
    { not: 'a session' },
  ];

  it('summarises the in-window sessions, newest first', () => {
    const context = buildCoachContext(rows, NOW);
    expect(context.windowDays).toBe(30);
    expect(context.totals.sessions).toBe(2);
    expect(context.recentSessions.map((s) => s.date)).toEqual(['2026-10-14', '2026-10-10']);
    expect(context.recentSessions[0]?.exercises[0]).toEqual({
      name: 'Back squat',
      sets: 2,
      reps: 10,
      topWeightKg: 105,
    });
    expect(context.recentSessions[0]?.exercises[1]?.topWeightKg).toBeNull();
    expect(context.topExercises[0]?.name).toBe('Back squat');
    expect(context.topExercises[0]?.sessionCount).toBe(2);
    expect(context.weeklySessions.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('leaves out identifiers, notes and times of day', () => {
    const serialised = JSON.stringify(buildCoachContext(rows, NOW));
    expect(serialised).not.toContain(USER_ID);
    expect(serialised).not.toContain(STUDIO_ID);
    expect(serialised).not.toContain('Jane');
    expect(serialised).not.toContain('0612345678');
    expect(serialised).not.toContain('T18:00');
    expect(serialised).not.toContain('Deadlift');
  });

  it('caps the number of sessions, exercises per session and ranked exercises', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session(
        new Date(NOW - i * 12 * 60 * 60 * 1000).toISOString(),
        Array.from({ length: 30 }, (_, j) => ({
          name: `Exercise ${String(j)}`,
          sets: [{ reps: 5, weightKg: 20 }],
        })),
      ),
    );
    const context = buildCoachContext(many, NOW);
    expect(context.recentSessions).toHaveLength(COACH_MAX_SESSIONS);
    for (const s of context.recentSessions) {
      expect(s.exercises.length).toBeLessThanOrEqual(COACH_MAX_EXERCISES_PER_SESSION);
    }
    expect(context.topExercises).toHaveLength(COACH_MAX_RANKED_EXERCISES);
  });

  it('never leaks ids or notes and respects every cap (property)', () => {
    const exerciseArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim().length > 0),
      sets: fc.array(
        fc.record(
          {
            reps: fc.integer({ min: 0, max: 50 }),
            weightKg: fc.double({ min: 0, max: 400, noNaN: true }),
          },
          { requiredKeys: ['reps'] },
        ),
        { maxLength: 6 },
      ),
    });
    const notesMarker = 'NOTE-MARKER-7f3a';
    const sessionArb = fc
      .record({
        offsetHours: fc.integer({ min: 0, max: 40 * 24 }),
        exercises: fc.array(exerciseArb, { maxLength: 14 }),
      })
      .map(({ offsetHours, exercises }) =>
        session(new Date(NOW - offsetHours * 60 * 60 * 1000).toISOString(), exercises, {
          notes: notesMarker,
        }),
      );

    fc.assert(
      fc.property(fc.array(sessionArb, { maxLength: 30 }), (sessionRows) => {
        const context = buildCoachContext(sessionRows, NOW);
        const serialised = JSON.stringify(context);
        expect(serialised).not.toContain(USER_ID);
        expect(serialised).not.toContain(STUDIO_ID);
        expect(serialised).not.toContain(notesMarker);
        for (const row of sessionRows) expect(serialised).not.toContain(row.id);
        expect(context.recentSessions.length).toBeLessThanOrEqual(COACH_MAX_SESSIONS);
        expect(context.topExercises.length).toBeLessThanOrEqual(COACH_MAX_RANKED_EXERCISES);
        for (const s of context.recentSessions) {
          expect(s.exercises.length).toBeLessThanOrEqual(COACH_MAX_EXERCISES_PER_SESSION);
          for (const e of s.exercises) {
            expect([...e.name].length).toBeLessThanOrEqual(COACH_EXERCISE_NAME_MAX);
          }
        }
        expect(context.recentSessions.length).toBe(
          Math.min(context.totals.sessions, COACH_MAX_SESSIONS),
        );
      }),
    );
  });
});

describe('buildCoachPrompt', () => {
  it('frames the context and the question as data, in the requested language', () => {
    const context = buildCoachContext(
      [session('2026-10-14T18:00:00.000Z', [{ name: 'Squat', sets: [{ reps: 5 }] }])],
      NOW,
    );
    const fr = buildCoachPrompt(context, 'Comment progresser ?', 'fr');
    expect(fr.system).toContain('Answer in French.');
    expect(fr.system).toContain('not instructions');
    expect(fr.prompt).toContain(JSON.stringify(context));
    expect(fr.prompt.endsWith('Comment progresser ?')).toBe(true);
    expect(buildCoachPrompt(context, 'How?', 'en').system).toContain('Answer in English.');
  });
});
