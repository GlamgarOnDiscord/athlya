import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { formatLocalDate } from '../../features/format';
import {
  exerciseLine,
  localDate,
  msUntilNextLocalMidnight,
  programCard,
  TodayProgramController,
  todayPath,
} from '../../features/programs/today-program';
import { NetworkError } from '../../infrastructure/api/errors';
import { createFakeApi } from '../features-helpers';

import type { TodayWorkoutItem } from '@athlya/shared/schemas/api';

const PROGRAM_ID = randomUUID();

function item(overrides: Partial<TodayWorkoutItem> = {}): TodayWorkoutItem {
  return {
    subscriptionId: randomUUID(),
    program: { id: PROGRAM_ID, title: 'Strength 101' },
    startsOn: '2026-10-12',
    totalWeeks: 8,
    status: 'scheduled',
    weekNumber: 1,
    dayNumber: 7,
    workout: {
      id: randomUUID(),
      dayNumber: 7,
      title: 'Lower body',
      notes: 'Warm up first',
      exercises: [
        { name: 'Squat', sets: 4, reps: 8, weightKg: 60, restSec: 90 },
        { name: 'Plank', sets: 3, durationSec: 45 },
        { name: 'Stretch', sets: 1 },
      ],
    },
    ...overrides,
  };
}

describe('localDate', () => {
  it('uses the device calendar date, not the UTC one', () => {
    const date = new Date(2026, 9, 18, 0, 30);
    expect(localDate(date)).toBe('2026-10-18');
    expect(todayPath(date)).toBe('/v1/programs/today?date=2026-10-18');
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('programCard', () => {
  it('renders a scheduled workout with its exercises', () => {
    const card = programCard(item());
    expect(card).toMatchObject({
      programTitle: 'Strength 101',
      status: 'scheduled',
      headline: { key: 'mobile.program.weekDay', values: { week: 1, total: 8, day: 7 } },
      workoutTitle: 'Lower body',
      notes: 'Warm up first',
    });
    expect(card.exercises.map((line) => line.name)).toEqual(['Squat', 'Plank', 'Stretch']);
  });

  it('describes rest days, programs not started yet and finished programs', () => {
    expect(programCard(item({ status: 'rest', workout: null })).headline).toEqual({
      key: 'mobile.program.restDay',
    });
    const upcoming = programCard(
      item({
        status: 'not_started',
        startsOn: '2026-11-02',
        weekNumber: null,
        dayNumber: null,
        workout: null,
      }),
    );
    expect(upcoming.headline).toEqual({
      key: 'mobile.program.notStarted',
      values: { date: '2026-11-02' },
    });
    expect(upcoming.exercises).toEqual([]);
    expect(programCard(item({ status: 'completed', workout: null })).headline).toEqual({
      key: 'mobile.program.completed',
    });
  });
});

describe('exerciseLine', () => {
  it('describes reps, duration, load and rest', () => {
    expect(
      exerciseLine({ name: 'Squat', sets: 4, reps: 8, weightKg: 60, restSec: 90 }).parts,
    ).toEqual([
      { key: 'mobile.program.setsReps', values: { sets: 4, reps: 8 } },
      { key: 'mobile.program.weight', values: { weight: 60 } },
      { key: 'mobile.program.restBetweenSets', values: { seconds: 90 } },
    ]);
    expect(exerciseLine({ name: 'Plank', sets: 3, durationSec: 45 }).parts).toEqual([
      { key: 'mobile.program.setsDuration', values: { sets: 3, seconds: 45 } },
    ]);
    expect(exerciseLine({ name: 'Stretch', sets: 1 }).parts).toEqual([
      { key: 'mobile.program.sets', values: { sets: 1 } },
    ]);
  });

  it('shows the duration too when reps and a duration are both prescribed', () => {
    expect(exerciseLine({ name: 'Burpees', sets: 3, reps: 10, durationSec: 30 }).parts).toEqual([
      { key: 'mobile.program.setsReps', values: { sets: 3, reps: 10 } },
      { key: 'mobile.program.duration', values: { seconds: 30 } },
    ]);
  });

  it('carries the exercise notes', () => {
    expect(exerciseLine({ name: 'Squat', sets: 4, reps: 8, notes: ' Knees out ' }).notes).toBe(
      'Knees out',
    );
    expect(exerciseLine({ name: 'Squat', sets: 4, reps: 8, notes: ' ' }).notes).toBeNull();
    expect(exerciseLine({ name: 'Squat', sets: 4, reps: 8 }).notes).toBeNull();
  });
});

describe('msUntilNextLocalMidnight', () => {
  it('counts down to the next local day', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 18, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 18, 0, 0, 0))).toBe(86_400_000);
  });
});

describe('TodayProgramController', () => {
  it('fetches today for the member’s local date and validates the response', async () => {
    const api = createFakeApi();
    api.get.mockResolvedValue({ date: '2026-10-18', items: [item()] });
    const controller = new TodayProgramController(api, () => new Date(2026, 9, 18, 0, 30));
    await controller.load();
    expect(api.get).toHaveBeenCalledWith('/v1/programs/today?date=2026-10-18', {});
    expect(controller.get()).toMatchObject({ load: 'ready', date: '2026-10-18' });
    expect(controller.get().cards).toHaveLength(1);
  });

  it('reports invalid payloads and failures as errors', async () => {
    const api = createFakeApi();
    api.get.mockResolvedValueOnce({ date: '2026-10-18', items: [{ status: 'scheduled' }] });
    const controller = new TodayProgramController(api);
    await controller.load();
    expect(controller.get().load).toBe('error');

    api.get.mockRejectedValueOnce(new NetworkError('offline'));
    await controller.load();
    expect(controller.get().error).toEqual({ key: 'errors.network', authRequired: false });
  });

  it('forwards the caller’s signal and ignores the cancelled load', async () => {
    const api = createFakeApi();
    const controller = new TodayProgramController(api, () => new Date(2026, 9, 18, 9, 0));
    const abort = new AbortController();
    api.get.mockImplementation((...args: unknown[]) => {
      expect((args[1] as { signal?: AbortSignal }).signal).toBe(abort.signal);
      abort.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });
    await controller.load(abort.signal);
    expect(api.get).toHaveBeenCalledWith('/v1/programs/today?date=2026-10-18', {
      signal: abort.signal,
    });
    expect(controller.get().error).toBeNull();
  });
});

describe('formatLocalDate', () => {
  it('formats a calendar date without shifting it', () => {
    expect(formatLocalDate('2026-11-02', 'en')).toBe('2 November 2026');
    expect(formatLocalDate('2026-11-02', 'fr')).toBe('2 novembre 2026');
  });
});
