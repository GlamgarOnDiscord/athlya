import { describe, expect, it } from 'vitest';

import {
  MAX_PROGRAM_WEEKS,
  addExercise,
  addWeek,
  addWorkout,
  draftFromProgram,
  draftToCreatePayload,
  draftToUpdatePayload,
  emptyDraft,
  freeDays,
  removeExercise,
  removeWeek,
  updateExercise,
  updateWeek,
  updateWorkout,
  type ProgramDraft,
} from './program-form';

import type { ProgramDetail } from '@athlya/shared/schemas/api';

const PROGRAM: ProgramDetail = {
  id: '0b000000-0000-4000-8000-000000000001',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Strength 101',
  description: null,
  status: 'published',
  version: 3,
  weekCount: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  archivedAt: null,
  weeks: [
    {
      weekNumber: 1,
      title: 'Base',
      workouts: [
        {
          id: '0d000000-0000-4000-8000-000000000001',
          dayNumber: 3,
          title: 'Squat',
          notes: null,
          exercises: [{ name: 'Back squat', sets: 5, reps: 5, weightKg: 82.5 }],
        },
      ],
    },
  ],
};

function filledDraft(): ProgramDraft {
  let draft = { ...emptyDraft(), title: 'Strength 101' };
  draft = addWorkout(draft, 0);
  draft = updateWorkout(draft, 0, 0, { title: 'Squat' });
  return updateExercise(draft, 0, 0, 0, { name: 'Back squat', reps: '' });
}

describe('program-form', () => {
  it('starts with one empty draft week', () => {
    const draft = emptyDraft();
    expect(draft.status).toBe('draft');
    expect(draft.weeks).toHaveLength(1);
    expect(draft.weeks[0]?.workouts).toEqual([]);
  });

  it('adds workouts on the first free day, sorted, up to seven per week', () => {
    let draft = emptyDraft();
    for (let i = 0; i < 8; i += 1) draft = addWorkout(draft, 0);
    const days = draft.weeks[0]?.workouts.map((w) => w.dayNumber);
    expect(days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    draft = updateWorkout(emptyDraft(), 0, 0, { dayNumber: 5 });
    expect(draft.weeks[0]?.workouts).toEqual([]);
  });

  it('only offers free days, plus the current one', () => {
    let draft = addWorkout(addWorkout(emptyDraft(), 0), 0);
    draft = updateWorkout(draft, 0, 1, { dayNumber: 4 });
    const week = draft.weeks[0];
    if (week === undefined) throw new Error('week missing');
    expect(freeDays(week)).toEqual([2, 3, 5, 6, 7]);
    expect(freeDays(week, 4)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('caps the number of weeks', () => {
    let draft = emptyDraft();
    for (let i = 0; i < MAX_PROGRAM_WEEKS + 3; i += 1) draft = addWeek(draft);
    expect(draft.weeks).toHaveLength(MAX_PROGRAM_WEEKS);
  });

  it('renumbers weeks 1..n in the payload after a removal', () => {
    let draft = filledDraft();
    draft = addWeek(addWeek(draft));
    draft = updateWeek(draft, 2, { title: 'Peak' });
    draft = removeWeek(draft, 1);
    const result = draftToCreatePayload(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.weeks.map((w) => [w.weekNumber, w.title])).toEqual([
      [1, undefined],
      [2, 'Peak'],
    ]);
  });

  it('converts numeric inputs and drops empty optional ones', () => {
    const result = draftToCreatePayload(filledDraft());
    expect(result).toEqual({
      ok: true,
      payload: {
        title: 'Strength 101',
        status: 'draft',
        weeks: [
          {
            weekNumber: 1,
            workouts: [
              { dayNumber: 1, title: 'Squat', exercises: [{ name: 'Back squat', sets: 3 }] },
            ],
          },
        ],
      },
    });
  });

  it('reports invalid fields by payload path', () => {
    let draft = updateExercise(filledDraft(), 0, 0, 0, { name: ' ', sets: 'abc' });
    draft = updateWorkout(draft, 0, 0, { title: '' });
    draft = { ...draft, title: '' };
    const result = draftToCreatePayload(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'title',
      'weeks.0.workouts.0.exercises.0.name',
      'weeks.0.workouts.0.exercises.0.sets',
      'weeks.0.workouts.0.title',
    ]);
  });

  it('round-trips an existing program into an update with its version', () => {
    const draft = draftFromProgram(PROGRAM);
    expect(draft.weeks[0]?.workouts[0]?.exercises[0]).toMatchObject({
      name: 'Back squat',
      sets: '5',
      reps: '5',
      weightKg: '82.5',
      durationSec: '',
    });
    const result = draftToUpdatePayload(draft, PROGRAM.version);
    expect(result).toEqual({
      ok: true,
      payload: {
        version: 3,
        title: 'Strength 101',
        description: null,
        status: 'published',
        weeks: [
          {
            weekNumber: 1,
            title: 'Base',
            workouts: [
              {
                dayNumber: 3,
                title: 'Squat',
                exercises: [{ name: 'Back squat', sets: 5, reps: 5, weightKg: 82.5 }],
              },
            ],
          },
        ],
      },
    });
  });

  it('adds and removes exercises', () => {
    let draft = addExercise(filledDraft(), 0, 0);
    expect(draft.weeks[0]?.workouts[0]?.exercises).toHaveLength(2);
    draft = removeExercise(draft, 0, 0, 0);
    expect(draft.weeks[0]?.workouts[0]?.exercises).toHaveLength(1);
  });
});
