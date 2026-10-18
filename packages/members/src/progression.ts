/**
 * Members service — progression aggregator (task 22.1).
 *
 * Turns a member's workout history into the trends behind the
 * progression graphs: per-exercise training volume and estimated
 * one-rep max (1RM) per day, plus the weekly session frequency, over a
 * 30, 90 or 365-day window.
 *
 * Data shape
 * ----------
 * `workout_sessions.exercises` is a jsonb `Exercise[]`:
 * `{ name, sets: [{ reps, weightKg?, durationSec? }] }`. Every row the
 * repo hands back is re-validated with the shared
 * {@link WorkoutSessionSchema} before it is aggregated; a row that fails
 * (legacy payload, manual edit) is skipped and counted in
 * `skippedSessions` instead of failing the whole response.
 *
 * Formulas
 * --------
 *  - Volume of a set: `reps × weightKg`. A set without a weight
 *    (bodyweight, cardio) contributes 0.
 *  - Estimated 1RM of a set, Epley (1985): `1RM = w × (1 + r / 30)`,
 *    with `1RM = w` for a single. Only sets with `weightKg > 0` and
 *    `1 ≤ reps ≤ {@link EPLEY_MAX_REPS}` qualify: the formula drifts
 *    badly on high-rep sets, so those are left out rather than
 *    reported as an inflated max.
 *  - A day's point keeps the day's summed volume and its best 1RM.
 *
 * Window
 * ------
 * The window covers `windowDays` whole UTC days ending with today,
 * `[from, to)` where `to` is the next UTC midnight. The result therefore
 * only changes within a day when the member logs a session, which lets
 * the gateway cache it with an ETag.
 *
 * {@link computeProgression} is pure; {@link getProgression} is the use
 * case that reads through a {@link ProgressionRepo}. The concrete repo,
 * wired in the API gateway, runs its query under `withTenantHttp` so the
 * `workout_sessions_read_own` RLS policy scopes it to the caller.
 */

import { PROGRESSION_WINDOWS } from '@athlya/shared/schemas/api';
import { WorkoutSessionSchema } from '@athlya/shared/schemas/domain';

import { MembersError } from './service.js';

import type {
  ExerciseProgression,
  ProgressionPoint,
  ProgressionResponse,
  ProgressionWindow,
  WeeklyFrequency,
} from '@athlya/shared/schemas/api';
import type { WorkoutSession } from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Highest rep count a set may have to feed the Epley estimate. */
export const EPLEY_MAX_REPS = 12;

/**
 * Most sessions read for one window. Two sessions a day for a year is
 * 730; anything above is cut to the most recent rows and flagged with
 * `truncated: true`.
 */
export const PROGRESSION_SESSION_LIMIT = 1000;

/** Most exercises returned, ranked by session count then volume. */
export const PROGRESSION_MAX_EXERCISES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

export interface ProgressionWindowBounds {
  /** Inclusive lower bound (UTC midnight). */
  readonly from: Date;
  /** Exclusive upper bound (next UTC midnight). */
  readonly to: Date;
}

export interface ListProgressionSessionsOptions extends ProgressionWindowBounds {
  readonly limit: number;
}

/**
 * Read port for the progression use case. Implementations return the
 * caller's sessions with `startedAt` in `[from, to)`, newest first, at
 * most `limit` rows, shaped like {@link WorkoutSession} (the aggregator
 * validates every row, so the type is `unknown`).
 */
export interface ProgressionRepo {
  listInWindow(userId: string, opts: ListProgressionSessionsOptions): Promise<readonly unknown[]>;
}

export interface ProgressionServiceDeps {
  repo: ProgressionRepo;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/** Round to one decimal (0.1 kg). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch ms of the UTC midnight starting the day containing `ms`. */
function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Epoch ms of the Monday (UTC midnight) starting the ISO week of `ms`. */
function startOfIsoWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY_MS;
}

/** True when `value` is one of {@link PROGRESSION_WINDOWS}. */
export function isProgressionWindow(value: unknown): value is ProgressionWindow {
  return (PROGRESSION_WINDOWS as readonly unknown[]).includes(value);
}

/**
 * Epley estimate of the one-rep max of a set, or `null` when the set
 * does not qualify (no weight, zero reps, or more than
 * {@link EPLEY_MAX_REPS} reps).
 */
export function estimateOneRepMax(weightKg: number | undefined, reps: number): number | null {
  if (weightKg === undefined || !(weightKg > 0)) return null;
  if (!Number.isInteger(reps) || reps < 1 || reps > EPLEY_MAX_REPS) return null;
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
}

/** Grouping key of an exercise name: trimmed, lower-cased, single-spaced. */
export function exerciseKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** `[from, to)` of a window ending with the UTC day containing `nowMs`. */
export function progressionWindowBounds(
  windowDays: ProgressionWindow,
  nowMs: number,
): ProgressionWindowBounds {
  const to = startOfUtcDay(nowMs) + DAY_MS;
  return { from: new Date(to - windowDays * DAY_MS), to: new Date(to) };
}

/* ------------------------------------------------------------------ */
/*  Aggregation                                                        */
/* ------------------------------------------------------------------ */

interface DayAccumulator {
  volume: number;
  best: number | null;
}

interface ExerciseAccumulator {
  name: string;
  sessions: number;
  volume: number;
  best: number | null;
  days: Map<string, DayAccumulator>;
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export interface ComputeProgressionOptions {
  readonly windowDays: ProgressionWindow;
  /** Reference clock, epoch ms. */
  readonly now: number;
  /** Set when the repo had more rows than it returned. */
  readonly truncated?: boolean;
}

/**
 * Aggregate `rows` into the progression response for the window ending
 * today (UTC). Pure: same input, same output.
 *
 * Rows that fail {@link WorkoutSessionSchema} are counted in
 * `skippedSessions`; valid rows outside the window are ignored.
 */
export function computeProgression(
  rows: readonly unknown[],
  opts: ComputeProgressionOptions,
): ProgressionResponse {
  const { from, to } = progressionWindowBounds(opts.windowDays, opts.now);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  let skippedSessions = 0;
  const sessions: Array<{ at: number; session: WorkoutSession }> = [];
  for (const row of rows) {
    const parsed = WorkoutSessionSchema.safeParse(row);
    if (!parsed.success) {
      skippedSessions += 1;
      continue;
    }
    const at = Date.parse(parsed.data.startedAt);
    if (at >= fromMs && at < toMs) sessions.push({ at, session: parsed.data });
  }
  // Oldest first, so the last spelling seen is the most recent one.
  sessions.sort((a, b) => a.at - b.at);

  const exercises = new Map<string, ExerciseAccumulator>();
  const weeks = new Map<number, number>();
  let totalVolume = 0;

  for (const { at, session } of sessions) {
    const day = utcDay(at);
    const week = startOfIsoWeek(at);
    weeks.set(week, (weeks.get(week) ?? 0) + 1);

    const seenInSession = new Set<string>();
    for (const exercise of session.exercises) {
      const key = exerciseKey(exercise.name);
      let acc = exercises.get(key);
      if (acc === undefined) {
        acc = { name: exercise.name.trim(), sessions: 0, volume: 0, best: null, days: new Map() };
        exercises.set(key, acc);
      }
      acc.name = exercise.name.trim();
      if (!seenInSession.has(key)) {
        seenInSession.add(key);
        acc.sessions += 1;
      }

      let dayAcc = acc.days.get(day);
      if (dayAcc === undefined) {
        dayAcc = { volume: 0, best: null };
        acc.days.set(day, dayAcc);
      }
      for (const set of exercise.sets) {
        const volume = set.weightKg === undefined ? 0 : set.reps * set.weightKg;
        dayAcc.volume += volume;
        acc.volume += volume;
        totalVolume += volume;
        const estimate = estimateOneRepMax(set.weightKg, set.reps);
        dayAcc.best = maxOrNull(dayAcc.best, estimate);
        acc.best = maxOrNull(acc.best, estimate);
      }
    }
  }

  const ranked: ExerciseProgression[] = [...exercises.entries()]
    .sort(
      ([keyA, a], [keyB, b]) =>
        b.sessions - a.sessions || b.volume - a.volume || keyA.localeCompare(keyB),
    )
    .slice(0, PROGRESSION_MAX_EXERCISES)
    .map(([key, acc]) => ({
      key,
      name: acc.name,
      sessionCount: acc.sessions,
      totalVolumeKg: round1(acc.volume),
      bestEstimatedOneRepMaxKg: acc.best === null ? null : round1(acc.best),
      points: [...acc.days.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, d]): ProgressionPoint => ({
          date,
          volumeKg: round1(d.volume),
          estimatedOneRepMaxKg: d.best === null ? null : round1(d.best),
        })),
    }));

  const weeklyFrequency: WeeklyFrequency[] = [];
  for (let week = startOfIsoWeek(fromMs); week < toMs; week += 7 * DAY_MS) {
    weeklyFrequency.push({ weekStart: utcDay(week), sessions: weeks.get(week) ?? 0 });
  }

  return {
    windowDays: opts.windowDays,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: { sessions: sessions.length, volumeKg: round1(totalVolume) },
    exercises: ranked,
    weeklyFrequency,
    truncated: opts.truncated === true,
    skippedSessions,
  };
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Progression of `userId` over the last `windowDays` UTC days.
 *
 * Reads at most {@link PROGRESSION_SESSION_LIMIT} sessions (newest
 * first) and flags the response `truncated` when more exist.
 *
 * Throws {@link MembersError} `validation_failed` when `windowDays` is
 * not 30, 90 or 365.
 */
export async function getProgression(
  userId: string,
  windowDays: unknown,
  deps: ProgressionServiceDeps,
): Promise<ProgressionResponse> {
  if (!isProgressionWindow(windowDays)) {
    throw new MembersError('validation_failed', 'window must be one of 30, 90 or 365', [
      { path: 'window', code: 'invalid_value', message: 'must be one of 30, 90 or 365' },
    ]);
  }
  const now = (deps.now ?? Date.now)();
  const bounds = progressionWindowBounds(windowDays, now);
  const rows = await deps.repo.listInWindow(userId, {
    ...bounds,
    limit: PROGRESSION_SESSION_LIMIT + 1,
  });
  const truncated = rows.length > PROGRESSION_SESSION_LIMIT;
  return computeProgression(truncated ? rows.slice(0, PROGRESSION_SESSION_LIMIT) : rows, {
    windowDays,
    now,
    truncated,
  });
}
