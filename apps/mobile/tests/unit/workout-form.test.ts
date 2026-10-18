import { describe, expect, it } from 'vitest';

import {
  buildLogSessionRequest,
  createDraft,
  MAX_EXERCISES,
  MAX_SETS,
  submitWorkout,
  workoutReducer,
  type WorkoutAction,
  type WorkoutDraft,
} from '../../features/workouts/workout-form';
import { ApiError, NetworkError } from '../../infrastructure/api/errors';
import { createWriteDeps } from '../features-helpers';
import { OWNER } from '../helpers';

const STARTED = new Date('2026-10-18T07:30:00.000Z');

function apply(draft: WorkoutDraft, ...actions: WorkoutAction[]): WorkoutDraft {
  return actions.reduce(workoutReducer, draft);
}

function filled(): WorkoutDraft {
  return apply(
    createDraft(STARTED),
    { type: 'renameExercise', exercise: 0, name: ' Squat ' },
    { type: 'updateSet', exercise: 0, set: 0, field: 'reps', value: '8' },
    { type: 'updateSet', exercise: 0, set: 0, field: 'weightKg', value: '72,5' },
    { type: 'addSet', exercise: 0 },
    { type: 'setDuration', value: '45' },
    { type: 'setNotes', value: '  Felt strong  ' },
  );
}

describe('workoutReducer', () => {
  it('starts with one empty exercise and copies the previous set', () => {
    const draft = filled();
    expect(draft.exercises).toHaveLength(1);
    expect(draft.exercises[0]?.sets).toEqual([
      { reps: '8', weightKg: '72,5' },
      { reps: '8', weightKg: '72,5' },
    ]);
  });

  it('adds and removes exercises and sets', () => {
    const draft = apply(
      createDraft(STARTED),
      { type: 'addExercise' },
      { type: 'removeExercise', exercise: 0 },
      { type: 'addSet', exercise: 0 },
      { type: 'removeSet', exercise: 0, set: 1 },
    );
    expect(draft.exercises).toHaveLength(1);
    expect(draft.exercises[0]?.sets).toHaveLength(1);
  });

  it('caps exercises at 50 and sets at 30 (Requirements 12.2, 12.3)', () => {
    let draft = createDraft(STARTED);
    for (let i = 0; i < MAX_EXERCISES + 5; i += 1)
      draft = workoutReducer(draft, { type: 'addExercise' });
    for (let i = 0; i < MAX_SETS + 5; i += 1)
      draft = workoutReducer(draft, { type: 'addSet', exercise: 0 });
    expect(draft.exercises).toHaveLength(MAX_EXERCISES);
    expect(draft.exercises[0]?.sets).toHaveLength(MAX_SETS);
  });

  it('ignores out-of-range indexes and resets', () => {
    const draft = filled();
    expect(workoutReducer(draft, { type: 'addSet', exercise: 9 })).toBe(draft);
    const reset = workoutReducer(draft, { type: 'reset', startedAt: '2026-10-18T09:00:00.000Z' });
    expect(reset).toEqual(createDraft(new Date('2026-10-18T09:00:00.000Z')));
  });
});

describe('buildLogSessionRequest', () => {
  it('builds a LogSessionRequest, accepting a decimal comma', () => {
    expect(buildLogSessionRequest(filled())).toEqual({
      ok: true,
      request: {
        startedAt: STARTED.toISOString(),
        durationMin: 45,
        notes: 'Felt strong',
        exercises: [
          {
            name: 'Squat',
            sets: [
              { reps: 8, weightKg: 72.5 },
              { reps: 8, weightKg: 72.5 },
            ],
          },
        ],
      },
    });
  });

  it('omits blank optional fields', () => {
    const draft = apply(
      filled(),
      { type: 'setDuration', value: '' },
      { type: 'setNotes', value: ' ' },
      { type: 'updateSet', exercise: 0, set: 0, field: 'weightKg', value: '' },
    );
    const result = buildLogSessionRequest(draft);
    expect(result.ok && result.request).toEqual({
      startedAt: STARTED.toISOString(),
      exercises: [
        {
          name: 'Squat',
          sets: [{ reps: 8 }, { reps: 8, weightKg: 72.5 }],
        },
      ],
    });
  });

  it('points at each invalid field', () => {
    const draft = apply(
      createDraft(STARTED),
      { type: 'updateSet', exercise: 0, set: 0, field: 'reps', value: '8.5' },
      { type: 'updateSet', exercise: 0, set: 0, field: 'weightKg', value: 'heavy' },
      { type: 'setDuration', value: '0' },
    );
    const result = buildLogSessionRequest(draft);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((error) => error.key)).toEqual([
      'mobile.workout.errors.duration',
      'mobile.workout.errors.exerciseName',
      'mobile.workout.errors.reps',
      'mobile.workout.errors.weight',
    ]);
  });

  it('requires at least one exercise', () => {
    const draft = workoutReducer(createDraft(STARTED), { type: 'removeExercise', exercise: 0 });
    const result = buildLogSessionRequest(draft);
    expect(!result.ok && result.errors).toEqual([
      { field: { kind: 'form' }, key: 'mobile.workout.errors.noExercise' },
    ]);
  });

  it('enforces the shared schema ranges', () => {
    const draft = apply(
      filled(),
      { type: 'updateSet', exercise: 0, set: 1, field: 'reps', value: '1001' },
      { type: 'setNotes', value: 'x'.repeat(2001) },
    );
    const result = buildLogSessionRequest(draft);
    expect(!result.ok && result.errors).toEqual([
      {
        field: { kind: 'set', exercise: 0, set: 1, part: 'reps' },
        key: 'mobile.workout.errors.reps',
      },
      { field: { kind: 'notes' }, key: 'mobile.workout.errors.notes' },
    ]);
  });
});

describe('submitWorkout', () => {
  it('posts the session online', async () => {
    const { deps, api, queue } = createWriteDeps();
    api.post.mockResolvedValue({ id: 'x' });
    expect(await submitWorkout(deps, filled())).toEqual({ kind: 'sent' });
    expect(api.post).toHaveBeenCalledWith(
      '/v1/sessions',
      expect.objectContaining({ durationMin: 45 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) as string }),
    );
    expect(queue.size).toBe(0);
  });

  it('queues logSession when offline (Requirement 19.1)', async () => {
    const { deps, api, queue } = createWriteDeps();
    api.post.mockRejectedValue(new NetworkError('offline'));
    expect(await submitWorkout(deps, filled())).toEqual({ kind: 'queued' });
    expect(queue.peek()[0]).toMatchObject({
      ownerId: OWNER,
      kind: 'logSession',
      method: 'POST',
      path: '/v1/sessions',
      payload: { startedAt: STARTED.toISOString(), notes: 'Felt strong' },
    });
  });

  it('does not send an invalid form', async () => {
    const { deps, api } = createWriteDeps();
    const result = await submitWorkout(deps, createDraft(STARTED));
    expect(result.kind).toBe('invalid');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('surfaces API errors', async () => {
    const { deps, api } = createWriteDeps();
    api.post.mockRejectedValue(new ApiError(422));
    expect(await submitWorkout(deps, filled())).toEqual({
      kind: 'error',
      error: { key: 'errors.validation', authRequired: false },
    });
  });

  it('rethrows a cancellation instead of queueing it', async () => {
    const { deps, api, queue } = createWriteDeps();
    const controller = new AbortController();
    api.post.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new NetworkError('aborted'));
    });
    await expect(submitWorkout(deps, filled(), controller.signal)).rejects.toThrow();
    expect(queue.size).toBe(0);
  });
});
