/**
 * Today's prescribed workout on the mobile home — task 24.4,
 * Requirement 3.5. Renders `GET /v1/programs/today?date=YYYY-MM-DD`,
 * where `date` is the member's local calendar date (not UTC: a member in
 * Paris at 00:30 is on the next day already).
 */
import {
  TodayWorkoutResponseSchema,
  type ProgramExercise,
  type TodayWorkoutItem,
} from '@athlya/shared/schemas/api';

import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';

import type { ApiClient } from '../../infrastructure/api/client';
import type { TranslationKeys } from '@athlya/shared/i18n';

export interface Message {
  readonly key: TranslationKeys;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** `YYYY-MM-DD` of `date` in the device's time zone. */
export function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayPath(date: Date): string {
  return `/v1/programs/today?date=${localDate(date)}`;
}

/** Milliseconds until the next local midnight, when "today" changes. */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface ExerciseLine {
  readonly name: string;
  /** e.g. "4 × 8", "3 × 45 s", "4 × 8, 30 s", then optional load and rest. */
  readonly parts: readonly Message[];
  /** The coach's note for this exercise. */
  readonly notes: string | null;
}

export interface ProgramCard {
  readonly subscriptionId: string;
  readonly programTitle: string;
  readonly status: TodayWorkoutItem['status'];
  readonly headline: Message;
  readonly workoutTitle: string | null;
  readonly notes: string | null;
  readonly exercises: readonly ExerciseLine[];
}

export function exerciseLine(exercise: ProgramExercise): ExerciseLine {
  const parts: Message[] = [];
  if (exercise.reps !== undefined) {
    parts.push({
      key: 'mobile.program.setsReps',
      values: { sets: exercise.sets, reps: exercise.reps },
    });
  } else if (exercise.durationSec !== undefined) {
    parts.push({
      key: 'mobile.program.setsDuration',
      values: { sets: exercise.sets, seconds: exercise.durationSec },
    });
  } else {
    parts.push({ key: 'mobile.program.sets', values: { sets: exercise.sets } });
  }
  // Both are allowed by the contract (e.g. 8 reps within 30 s): show both.
  if (exercise.reps !== undefined && exercise.durationSec !== undefined) {
    parts.push({ key: 'mobile.program.duration', values: { seconds: exercise.durationSec } });
  }
  if (exercise.weightKg !== undefined) {
    parts.push({ key: 'mobile.program.weight', values: { weight: exercise.weightKg } });
  }
  if (exercise.restSec !== undefined) {
    parts.push({ key: 'mobile.program.restBetweenSets', values: { seconds: exercise.restSec } });
  }
  const notes = exercise.notes?.trim() ?? '';
  return { name: exercise.name, parts, notes: notes === '' ? null : notes };
}

function headline(item: TodayWorkoutItem): Message {
  switch (item.status) {
    case 'scheduled':
      return {
        key: 'mobile.program.weekDay',
        values: {
          week: item.weekNumber ?? 1,
          total: item.totalWeeks,
          day: item.dayNumber ?? 1,
        },
      };
    case 'rest':
      return { key: 'mobile.program.restDay' };
    case 'not_started':
      return { key: 'mobile.program.notStarted', values: { date: item.startsOn } };
    case 'completed':
      return { key: 'mobile.program.completed' };
  }
}

export function programCard(item: TodayWorkoutItem): ProgramCard {
  const workout = item.status === 'scheduled' ? item.workout : null;
  return {
    subscriptionId: item.subscriptionId,
    programTitle: item.program.title,
    status: item.status,
    headline: headline(item),
    workoutTitle: workout?.title ?? null,
    notes: workout?.notes ?? null,
    exercises: workout === null ? [] : workout.exercises.map(exerciseLine),
  };
}

export interface TodayProgramState {
  readonly load: 'idle' | 'loading' | 'ready' | 'error';
  /** The local date the cards are for. */
  readonly date: string | null;
  readonly cards: readonly ProgramCard[];
  readonly error: ErrorModel | null;
}

const INITIAL: TodayProgramState = { load: 'idle', date: null, cards: [], error: null };

export class TodayProgramController {
  readonly #api: Pick<ApiClient, 'get'>;
  readonly #now: () => Date;
  readonly #store = new Store<TodayProgramState>(INITIAL);
  #generation = 0;

  public constructor(api: Pick<ApiClient, 'get'>, now: () => Date = () => new Date()) {
    this.#api = api;
    this.#now = now;
  }

  public readonly get = (): TodayProgramState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  public async load(signal?: AbortSignal): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const now = this.#now();
    this.#store.set((state) => ({ ...state, load: 'loading', error: null }));
    try {
      const raw = await this.#api.get<unknown>(todayPath(now), {
        ...(signal === undefined ? {} : { signal }),
      });
      const response = TodayWorkoutResponseSchema.parse(raw);
      if (generation !== this.#generation) return;
      this.#store.set({
        load: 'ready',
        date: response.date,
        cards: response.items.map(programCard),
        error: null,
      });
    } catch (error) {
      if (generation !== this.#generation || isAbortError(error)) return;
      this.#store.set((state) => ({ ...state, load: 'error', error: toErrorModel(error) }));
    }
  }
}
