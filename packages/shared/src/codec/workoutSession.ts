/**
 * Codec for the {@link WorkoutSession} domain model and its two
 * nested shapes ({@link Exercise}, {@link Set}).
 *
 * The nested codecs are split out for readability and composability
 * rather than strict necessity: the individual transforms are tiny
 * and the top-level `toJSON` could inline them without harming
 * correctness. Splitting pays off whenever a consumer needs to
 * serialise just an exercise template or a single set (which the
 * mobile app does when queuing an offline edit).
 *
 * ## Optional-field handling
 *
 * `Set.weightKg` and `Set.durationSec` are truly optional (key may be
 * absent, per Zod's `.optional()` + the repo's
 * `exactOptionalPropertyTypes: true` tsconfig flag). The codec
 * preserves presence versus absence so that a round-trip through
 * `toJSON` / `fromJSON` is structurally identical — including the
 * difference between `{reps: 10}` and `{reps: 10, weightKg: undefined}`.
 *
 * Round-trip guarantee (Requirement 21.3):
 *   `WorkoutSessionCodec.fromJSON(WorkoutSessionCodec.toJSON(x))` is
 *   structurally equal to `x` for every valid `WorkoutSession` value
 *   `x`.
 */

import {
  ExerciseSchema,
  SetSchema,
  WorkoutSessionSchema,
  type Exercise,
  type Set,
  type WorkoutSession,
} from '../schemas/domain.js';

import type { ExerciseWire, SetWire, WorkoutSessionWire } from './types.js';

/* ------------------------------------------------------------------ */
/*  Set                                                                */
/* ------------------------------------------------------------------ */

function setToJSON(value: Set): SetWire {
  // Build the object without forcing `undefined` on optional keys — that
  // preserves presence/absence semantics under `exactOptionalPropertyTypes`.
  const wire: { reps: number; weightKg?: number; durationSec?: number } = {
    reps: value.reps,
  };
  if (value.weightKg !== undefined) {
    wire.weightKg = value.weightKg;
  }
  if (value.durationSec !== undefined) {
    wire.durationSec = value.durationSec;
  }
  return wire;
}

function setFromJSON(raw: unknown): Set {
  return SetSchema.parse(raw);
}

export const SetCodec = {
  toJSON: setToJSON,
  fromJSON: setFromJSON,
} as const;

/* ------------------------------------------------------------------ */
/*  Exercise                                                           */
/* ------------------------------------------------------------------ */

function exerciseToJSON(value: Exercise): ExerciseWire {
  return {
    name: value.name,
    sets: value.sets.map(setToJSON),
  };
}

function exerciseFromJSON(raw: unknown): Exercise {
  return ExerciseSchema.parse(raw);
}

export const ExerciseCodec = {
  toJSON: exerciseToJSON,
  fromJSON: exerciseFromJSON,
} as const;

/* ------------------------------------------------------------------ */
/*  WorkoutSession                                                     */
/* ------------------------------------------------------------------ */

function toJSON(value: WorkoutSession): WorkoutSessionWire {
  return {
    id: value.id,
    userId: value.userId,
    studioId: value.studioId,
    startedAt: value.startedAt,
    durationMin: value.durationMin,
    exercises: value.exercises.map(exerciseToJSON),
    notes: value.notes,
    ...(value.cardio === undefined ? {} : { cardio: { ...value.cardio } }),
    createdAt: value.createdAt,
  };
}

function fromJSON(raw: unknown): WorkoutSession {
  return WorkoutSessionSchema.parse(raw);
}

export const WorkoutSessionCodec = {
  toJSON,
  fromJSON,
} as const;
