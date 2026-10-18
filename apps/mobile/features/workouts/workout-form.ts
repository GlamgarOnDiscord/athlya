/**
 * Workout session logging — task 11.10, Requirements 12.1–12.3 and 19.1.
 *
 * The form keeps raw text fields (what the user typed) and turns them into
 * a `LogSessionRequest` only on submit, where `LogSessionRequestSchema`
 * enforces the API limits (50 exercises, 30 sets per exercise). The
 * session is sent with `POST /v1/sessions`, or queued as `logSession`
 * with the same idempotency key when offline.
 */
import { LogSessionRequestSchema, type LogSessionRequest } from '@athlya/shared/schemas/api';

import { toErrorModel, type ErrorModel } from '../errors';
import { submitWrite, toJsonPayload, type WriteDeps } from '../writes';

import type { TranslationKeys } from '@athlya/shared/i18n';

export const LOG_SESSION_KIND = 'logSession';
export const SESSIONS_PATH = '/v1/sessions';
export const MAX_EXERCISES = 50;
export const MAX_SETS = 30;

export interface SetDraft {
  readonly reps: string;
  readonly weightKg: string;
}

export interface ExerciseDraft {
  readonly name: string;
  readonly sets: readonly SetDraft[];
}

export interface WorkoutDraft {
  /** When the form was opened; becomes `startedAt`. */
  readonly startedAt: string;
  readonly durationMin: string;
  readonly notes: string;
  readonly exercises: readonly ExerciseDraft[];
}

export type WorkoutAction =
  | { readonly type: 'addExercise' }
  | { readonly type: 'removeExercise'; readonly exercise: number }
  | { readonly type: 'renameExercise'; readonly exercise: number; readonly name: string }
  | { readonly type: 'addSet'; readonly exercise: number }
  | { readonly type: 'removeSet'; readonly exercise: number; readonly set: number }
  | {
      readonly type: 'updateSet';
      readonly exercise: number;
      readonly set: number;
      readonly field: keyof SetDraft;
      readonly value: string;
    }
  | { readonly type: 'setDuration'; readonly value: string }
  | { readonly type: 'setNotes'; readonly value: string }
  | { readonly type: 'reset'; readonly startedAt: string };

const EMPTY_SET: SetDraft = { reps: '', weightKg: '' };

export function createDraft(startedAt: Date): WorkoutDraft {
  return {
    startedAt: startedAt.toISOString(),
    durationMin: '',
    notes: '',
    exercises: [{ name: '', sets: [EMPTY_SET] }],
  };
}

function updateExercise(
  draft: WorkoutDraft,
  index: number,
  update: (exercise: ExerciseDraft) => ExerciseDraft,
): WorkoutDraft {
  if (draft.exercises[index] === undefined) return draft;
  return {
    ...draft,
    exercises: draft.exercises.map((exercise, i) => (i === index ? update(exercise) : exercise)),
  };
}

export function workoutReducer(draft: WorkoutDraft, action: WorkoutAction): WorkoutDraft {
  switch (action.type) {
    case 'addExercise':
      if (draft.exercises.length >= MAX_EXERCISES) return draft;
      return { ...draft, exercises: [...draft.exercises, { name: '', sets: [EMPTY_SET] }] };
    case 'removeExercise':
      return { ...draft, exercises: draft.exercises.filter((_, i) => i !== action.exercise) };
    case 'renameExercise':
      return updateExercise(draft, action.exercise, (exercise) => ({
        ...exercise,
        name: action.name,
      }));
    case 'addSet':
      return updateExercise(draft, action.exercise, (exercise) => {
        if (exercise.sets.length >= MAX_SETS) return exercise;
        // A new set starts from the previous one: most sets repeat it.
        const last = exercise.sets.at(-1) ?? EMPTY_SET;
        return { ...exercise, sets: [...exercise.sets, { ...last }] };
      });
    case 'removeSet':
      return updateExercise(draft, action.exercise, (exercise) => ({
        ...exercise,
        sets: exercise.sets.filter((_, i) => i !== action.set),
      }));
    case 'updateSet':
      return updateExercise(draft, action.exercise, (exercise) => ({
        ...exercise,
        sets: exercise.sets.map((set, i) =>
          i === action.set ? { ...set, [action.field]: action.value } : set,
        ),
      }));
    case 'setDuration':
      return { ...draft, durationMin: action.value };
    case 'setNotes':
      return { ...draft, notes: action.value };
    case 'reset':
      return createDraft(new Date(action.startedAt));
  }
}

/** A field that failed validation, addressed by its position in the form. */
export interface WorkoutFieldError {
  readonly field:
    | { readonly kind: 'form' }
    | { readonly kind: 'duration' }
    | { readonly kind: 'notes' }
    | { readonly kind: 'exerciseName'; readonly exercise: number }
    | {
        readonly kind: 'set';
        readonly exercise: number;
        readonly set: number;
        readonly part: keyof SetDraft;
      };
  readonly key: TranslationKeys;
}

export type BuildResult =
  | { readonly ok: true; readonly request: LogSessionRequest }
  | { readonly ok: false; readonly errors: readonly WorkoutFieldError[] };

const INTEGER = /^\d+$/u;
const DECIMAL = /^\d+(?:[.,]\d+)?$/u;

/** Parses a whole number field; `undefined` when blank, `null` when invalid. */
function parseInteger(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  return INTEGER.test(value) ? Number(value) : null;
}

/** Parses a decimal field, accepting a comma as the decimal separator (FR keyboards). */
function parseDecimal(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  return DECIMAL.test(value) ? Number(value.replace(',', '.')) : null;
}

export function buildLogSessionRequest(draft: WorkoutDraft): BuildResult {
  const errors: WorkoutFieldError[] = [];
  if (draft.exercises.length === 0) {
    errors.push({ field: { kind: 'form' }, key: 'mobile.workout.errors.noExercise' });
  }

  const duration = parseInteger(draft.durationMin);
  if (duration === null || duration === 0) {
    errors.push({ field: { kind: 'duration' }, key: 'mobile.workout.errors.duration' });
  }

  const exercises = draft.exercises.map((exercise, exerciseIndex) => {
    if (exercise.name.trim() === '') {
      errors.push({
        field: { kind: 'exerciseName', exercise: exerciseIndex },
        key: 'mobile.workout.errors.exerciseName',
      });
    }
    const sets = exercise.sets.map((set, setIndex) => {
      const reps = parseInteger(set.reps);
      if (reps === undefined || reps === null) {
        errors.push({
          field: { kind: 'set', exercise: exerciseIndex, set: setIndex, part: 'reps' },
          key: 'mobile.workout.errors.reps',
        });
      }
      const weightKg = parseDecimal(set.weightKg);
      if (weightKg === null) {
        errors.push({
          field: { kind: 'set', exercise: exerciseIndex, set: setIndex, part: 'weightKg' },
          key: 'mobile.workout.errors.weight',
        });
      }
      return {
        reps: reps ?? 0,
        ...(weightKg === undefined || weightKg === null ? {} : { weightKg }),
      };
    });
    return { name: exercise.name.trim(), sets };
  });

  if (errors.length > 0) return { ok: false, errors };

  const notes = draft.notes.trim();
  const parsed = LogSessionRequestSchema.safeParse({
    startedAt: draft.startedAt,
    ...(duration === undefined || duration === null ? {} : { durationMin: duration }),
    exercises,
    ...(notes === '' ? {} : { notes }),
  });
  if (parsed.success) return { ok: true, request: parsed.data };

  // Range checks the text parsing above does not cover (reps > 1000,
  // weight > 1000 kg, notes > 2000 chars, more than 50/30 items).
  for (const issue of parsed.error.issues) {
    const [root, exercise, child, set, part] = issue.path;
    if (root === 'exercises' && typeof exercise === 'number' && child === 'name') {
      errors.push({
        field: { kind: 'exerciseName', exercise },
        key: 'mobile.workout.errors.exerciseName',
      });
    } else if (
      root === 'exercises' &&
      typeof exercise === 'number' &&
      typeof set === 'number' &&
      (part === 'reps' || part === 'weightKg')
    ) {
      errors.push({
        field: { kind: 'set', exercise, set, part },
        key: part === 'reps' ? 'mobile.workout.errors.reps' : 'mobile.workout.errors.weight',
      });
    } else if (root === 'notes') {
      errors.push({ field: { kind: 'notes' }, key: 'mobile.workout.errors.notes' });
    } else if (root === 'durationMin') {
      errors.push({ field: { kind: 'duration' }, key: 'mobile.workout.errors.duration' });
    } else {
      errors.push({ field: { kind: 'form' }, key: 'errors.validation' });
    }
  }
  return { ok: false, errors };
}

export type SubmitWorkoutResult =
  | { readonly kind: 'sent' | 'queued' }
  | { readonly kind: 'invalid'; readonly errors: readonly WorkoutFieldError[] }
  | { readonly kind: 'error'; readonly error: ErrorModel };

export async function submitWorkout(
  writes: WriteDeps,
  draft: WorkoutDraft,
  signal?: AbortSignal,
): Promise<SubmitWorkoutResult> {
  const built = buildLogSessionRequest(draft);
  if (!built.ok) return { kind: 'invalid', errors: built.errors };
  try {
    const outcome = await submitWrite<unknown>(writes, {
      kind: LOG_SESSION_KIND,
      method: 'POST',
      path: SESSIONS_PATH,
      payload: toJsonPayload(built.request),
      ...(signal === undefined ? {} : { signal }),
    });
    return { kind: outcome.kind };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { kind: 'error', error: toErrorModel(error) };
  }
}
