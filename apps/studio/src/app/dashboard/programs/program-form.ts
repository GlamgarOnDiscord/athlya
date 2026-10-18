/**
 * Pure state of the program editor (Epic 24, task 24.3).
 *
 * Inputs keep their raw string values so a half-typed number never
 * fights the user; `draftToPayload` converts and validates the whole
 * draft against the same shared Zod schemas the API enforces, and
 * reports issues by their dotted path (`weeks.0.workouts.1.title`).
 * Weeks are always renumbered 1..n, matching the API's contiguity rule.
 */
import {
  CreateProgramRequestSchema,
  MAX_PROGRAM_EXERCISES,
  MAX_PROGRAM_WEEKS,
  UpdateProgramRequestSchema,
  type CreateProgramRequest,
  type ProgramDetail,
  type ProgramExercise,
  type UpdateProgramRequest,
} from '@athlya/shared/schemas/api';

export { MAX_PROGRAM_EXERCISES, MAX_PROGRAM_WEEKS };

export interface ExerciseDraft {
  readonly key: string;
  readonly name: string;
  readonly sets: string;
  readonly reps: string;
  readonly durationSec: string;
  readonly weightKg: string;
  readonly restSec: string;
}

export interface WorkoutDraft {
  readonly key: string;
  readonly dayNumber: number;
  readonly title: string;
  readonly notes: string;
  readonly exercises: ReadonlyArray<ExerciseDraft>;
}

export interface WeekDraft {
  readonly key: string;
  readonly title: string;
  readonly workouts: ReadonlyArray<WorkoutDraft>;
}

export interface ProgramDraft {
  readonly title: string;
  readonly description: string;
  readonly status: 'draft' | 'published';
  readonly weeks: ReadonlyArray<WeekDraft>;
}

let keySeq = 0;
/** Stable React keys for rows that have no server id yet. */
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-${String(keySeq)}`;
}

const numberText = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

export function emptyExercise(): ExerciseDraft {
  return {
    key: nextKey('exercise'),
    name: '',
    sets: '3',
    reps: '10',
    durationSec: '',
    weightKg: '',
    restSec: '',
  };
}

export function emptyWeek(): WeekDraft {
  return { key: nextKey('week'), title: '', workouts: [] };
}

export function emptyDraft(): ProgramDraft {
  return { title: '', description: '', status: 'draft', weeks: [emptyWeek()] };
}

function exerciseFromApi(exercise: ProgramExercise): ExerciseDraft {
  return {
    key: nextKey('exercise'),
    name: exercise.name,
    sets: String(exercise.sets),
    reps: numberText(exercise.reps),
    durationSec: numberText(exercise.durationSec),
    weightKg: numberText(exercise.weightKg),
    restSec: numberText(exercise.restSec),
  };
}

export function draftFromProgram(program: ProgramDetail): ProgramDraft {
  return {
    title: program.title,
    description: program.description ?? '',
    status: program.status === 'published' ? 'published' : 'draft',
    weeks: program.weeks.map((week) => ({
      key: nextKey('week'),
      title: week.title ?? '',
      workouts: week.workouts.map((workout) => ({
        key: workout.id,
        dayNumber: workout.dayNumber,
        title: workout.title,
        notes: workout.notes ?? '',
        exercises: workout.exercises.map(exerciseFromApi),
      })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Immutable edits                                                    */
/* ------------------------------------------------------------------ */

const replaceAt = <T>(items: ReadonlyArray<T>, index: number, next: T): T[] =>
  items.map((item, i) => (i === index ? next : item));

const removeAt = <T>(items: ReadonlyArray<T>, index: number): T[] =>
  items.filter((_, i) => i !== index);

export function addWeek(draft: ProgramDraft): ProgramDraft {
  if (draft.weeks.length >= MAX_PROGRAM_WEEKS) return draft;
  return { ...draft, weeks: [...draft.weeks, emptyWeek()] };
}

export function removeWeek(draft: ProgramDraft, weekIndex: number): ProgramDraft {
  return { ...draft, weeks: removeAt(draft.weeks, weekIndex) };
}

export function updateWeek(
  draft: ProgramDraft,
  weekIndex: number,
  patch: Partial<Omit<WeekDraft, 'key' | 'workouts'>>,
): ProgramDraft {
  const week = draft.weeks[weekIndex];
  if (week === undefined) return draft;
  return { ...draft, weeks: replaceAt(draft.weeks, weekIndex, { ...week, ...patch }) };
}

/** Days 1..7 not yet holding a workout in the week. */
export function freeDays(week: WeekDraft, keep?: number): number[] {
  const taken = new Set(week.workouts.map((w) => w.dayNumber));
  return [1, 2, 3, 4, 5, 6, 7].filter((day) => day === keep || !taken.has(day));
}

export function addWorkout(draft: ProgramDraft, weekIndex: number): ProgramDraft {
  const week = draft.weeks[weekIndex];
  const day = week === undefined ? undefined : freeDays(week)[0];
  if (week === undefined || day === undefined) return draft;
  const workout: WorkoutDraft = {
    key: nextKey('workout'),
    dayNumber: day,
    title: '',
    notes: '',
    exercises: [emptyExercise()],
  };
  const workouts = [...week.workouts, workout].sort((a, b) => a.dayNumber - b.dayNumber);
  return { ...draft, weeks: replaceAt(draft.weeks, weekIndex, { ...week, workouts }) };
}

function mapWorkout(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
  fn: (workout: WorkoutDraft) => WorkoutDraft | null,
): ProgramDraft {
  const week = draft.weeks[weekIndex];
  const workout = week?.workouts[workoutIndex];
  if (week === undefined || workout === undefined) return draft;
  const next = fn(workout);
  const workouts =
    next === null
      ? removeAt(week.workouts, workoutIndex)
      : replaceAt(week.workouts, workoutIndex, next).sort((a, b) => a.dayNumber - b.dayNumber);
  return { ...draft, weeks: replaceAt(draft.weeks, weekIndex, { ...week, workouts }) };
}

export function removeWorkout(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
): ProgramDraft {
  return mapWorkout(draft, weekIndex, workoutIndex, () => null);
}

export function updateWorkout(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
  patch: Partial<Omit<WorkoutDraft, 'key' | 'exercises'>>,
): ProgramDraft {
  return mapWorkout(draft, weekIndex, workoutIndex, (w) => ({ ...w, ...patch }));
}

export function addExercise(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
): ProgramDraft {
  return mapWorkout(draft, weekIndex, workoutIndex, (w) =>
    w.exercises.length >= MAX_PROGRAM_EXERCISES
      ? w
      : { ...w, exercises: [...w.exercises, emptyExercise()] },
  );
}

export function removeExercise(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
  exerciseIndex: number,
): ProgramDraft {
  return mapWorkout(draft, weekIndex, workoutIndex, (w) => ({
    ...w,
    exercises: removeAt(w.exercises, exerciseIndex),
  }));
}

export function updateExercise(
  draft: ProgramDraft,
  weekIndex: number,
  workoutIndex: number,
  exerciseIndex: number,
  patch: Partial<Omit<ExerciseDraft, 'key'>>,
): ProgramDraft {
  return mapWorkout(draft, weekIndex, workoutIndex, (w) => {
    const exercise = w.exercises[exerciseIndex];
    if (exercise === undefined) return w;
    return { ...w, exercises: replaceAt(w.exercises, exerciseIndex, { ...exercise, ...patch }) };
  });
}

/* ------------------------------------------------------------------ */
/*  Payload                                                            */
/* ------------------------------------------------------------------ */

/** `''` → absent; anything else → a number (NaN fails validation). */
const optionalNumber = (value: string): number | undefined =>
  value.trim() === '' ? undefined : Number(value);

const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;

function exerciseToApi(exercise: ExerciseDraft): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    name: exercise.name,
    sets: Number(exercise.sets),
    reps: optionalNumber(exercise.reps),
    durationSec: optionalNumber(exercise.durationSec),
    weightKg: optionalNumber(exercise.weightKg),
    restSec: optionalNumber(exercise.restSec),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function weeksToApi(draft: ProgramDraft): unknown[] {
  return draft.weeks.map((week, index) => ({
    weekNumber: index + 1,
    ...(optionalText(week.title) !== undefined ? { title: week.title } : {}),
    workouts: week.workouts.map((workout) => ({
      dayNumber: workout.dayNumber,
      title: workout.title,
      ...(optionalText(workout.notes) !== undefined ? { notes: workout.notes } : {}),
      exercises: workout.exercises.map(exerciseToApi),
    })),
  }));
}

export type FieldErrors = Readonly<Record<string, string>>;

export type PayloadResult<T> =
  { readonly ok: true; readonly payload: T } | { readonly ok: false; readonly errors: FieldErrors };

function collectIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    errors[path] ??= issue.message;
  }
  return errors;
}

export function draftToCreatePayload(draft: ProgramDraft): PayloadResult<CreateProgramRequest> {
  const parsed = CreateProgramRequestSchema.safeParse({
    title: draft.title,
    ...(optionalText(draft.description) !== undefined ? { description: draft.description } : {}),
    status: draft.status,
    weeks: weeksToApi(draft),
  });
  return parsed.success
    ? { ok: true, payload: parsed.data }
    : { ok: false, errors: collectIssues(parsed.error.issues) };
}

export function draftToUpdatePayload(
  draft: ProgramDraft,
  version: number,
): PayloadResult<UpdateProgramRequest> {
  const parsed = UpdateProgramRequestSchema.safeParse({
    version,
    title: draft.title,
    description: optionalText(draft.description) ?? null,
    status: draft.status,
    weeks: weeksToApi(draft),
  });
  return parsed.success
    ? { ok: true, payload: parsed.data }
    : { ok: false, errors: collectIssues(parsed.error.issues) };
}
