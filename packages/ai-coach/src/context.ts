/**
 * Minimised training context sent to the language model (task 21.1).
 *
 * The context is built from the member's own workout sessions of the
 * last {@link COACH_CONTEXT_DAYS} days and from the progression summary
 * that `@athlya/members` computes over the same rows. Data minimisation
 * (RGPD art. 5.1.c) is enforced here, in one pure function:
 *
 *   - no identifier: no user, studio or session id;
 *   - no profile data: no email, display name or avatar;
 *   - no free text but exercise names: session `notes` never leave the
 *     database, and exercise names are cleaned (control characters
 *     dropped, e-mail addresses and long digit runs masked, length cut
 *     to {@link COACH_EXERCISE_NAME_MAX});
 *   - dates are UTC days, without time of day;
 *   - sizes are capped (sessions, exercises per session, ranked
 *     exercises), so the prompt stays small whatever the history.
 */

import { computeProgression, progressionWindowBounds } from '@athlya/members/progression';
import { WorkoutSessionSchema } from '@athlya/shared/schemas/domain';

import type { WorkoutSession } from '@athlya/shared/schemas/domain';

/** Days of history the coach reads. */
export const COACH_CONTEXT_DAYS = 30;

/** Most recent sessions described one by one. */
export const COACH_MAX_SESSIONS = 15;

/** Exercises kept per described session. */
export const COACH_MAX_EXERCISES_PER_SESSION = 10;

/** Ranked exercises kept from the progression summary. */
export const COACH_MAX_RANKED_EXERCISES = 8;

/** Longest exercise name sent to the model. */
export const COACH_EXERCISE_NAME_MAX = 40;

/** Placeholder replacing masked fragments of an exercise name. */
export const COACH_MASK = '***';

export interface CoachExerciseSummary {
  readonly name: string;
  readonly sets: number;
  readonly reps: number;
  /** Heaviest set of the exercise in the session, or `null` (bodyweight). */
  readonly topWeightKg: number | null;
}

export interface CoachSessionSummary {
  /** UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly durationMin: number | null;
  readonly exercises: readonly CoachExerciseSummary[];
}

export interface CoachRankedExercise {
  readonly name: string;
  readonly sessionCount: number;
  readonly totalVolumeKg: number;
  readonly bestEstimatedOneRepMaxKg: number | null;
}

/** Everything the model sees about the member. */
export interface CoachContext {
  readonly windowDays: number;
  readonly totals: { readonly sessions: number; readonly volumeKg: number };
  /** Sessions per ISO week, oldest week first. */
  readonly weeklySessions: readonly number[];
  readonly topExercises: readonly CoachRankedExercise[];
  /** Newest first, at most {@link COACH_MAX_SESSIONS}. */
  readonly recentSessions: readonly CoachSessionSummary[];
  /**
   * True when more sessions exist in the window than were read: the
   * totals and weekly counts then cover the most recent rows only.
   */
  readonly truncated: boolean;
}

/**
 * Six digits or more, each optionally preceded by one space, dot or dash
 * (`0612345678`, `06 12 34 56 78`, `06-12-34-56-78`). The separator and
 * the digit classes are disjoint, so matching is linear.
 */
const DIGIT_RUN = /\d(?:[ .-]?\d){5,}/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Clean a free-text exercise name before it reaches the model: drop
 * control characters, mask runs of six digits or more, including runs
 * split by single spaces, dots or dashes (phone numbers, ids), mask
 * every word containing `@` (e-mail addresses), collapse whitespace and
 * cut the result to {@link COACH_EXERCISE_NAME_MAX} characters. Every
 * step is linear in the input length.
 */
export function sanitizeExerciseName(name: string): string {
  const cleaned = name
    .replace(CONTROL, ' ')
    .replace(DIGIT_RUN, COACH_MASK)
    .split(/\s/)
    .filter((word) => word.length > 0)
    .map((word) => (word.includes('@') ? COACH_MASK : word))
    .join(' ');
  const cut = [...cleaned].slice(0, COACH_EXERCISE_NAME_MAX).join('').trim();
  return cut.length > 0 ? cut : COACH_MASK;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function summariseSession(at: number, session: WorkoutSession): CoachSessionSummary {
  return {
    date: new Date(at).toISOString().slice(0, 10),
    durationMin: session.durationMin,
    exercises: session.exercises.slice(0, COACH_MAX_EXERCISES_PER_SESSION).map((exercise) => {
      let reps = 0;
      let top: number | null = null;
      for (const set of exercise.sets) {
        reps += set.reps;
        if (set.weightKg !== undefined && set.weightKg > 0) {
          top = top === null ? set.weightKg : Math.max(top, set.weightKg);
        }
      }
      return {
        name: sanitizeExerciseName(exercise.name),
        sets: exercise.sets.length,
        reps,
        topWeightKg: top === null ? null : round1(top),
      };
    }),
  };
}

/**
 * Build the {@link CoachContext} from the member's stored session rows.
 * Pure: same rows and clock, same context. Rows that fail
 * `WorkoutSessionSchema` or fall outside the window are ignored.
 * `truncated` tells that the caller read fewer rows than the window has.
 */
export function buildCoachContext(
  rows: readonly unknown[],
  now: number,
  truncated = false,
): CoachContext {
  const progression = computeProgression(rows, { windowDays: COACH_CONTEXT_DAYS, now });
  const { from, to } = progressionWindowBounds(COACH_CONTEXT_DAYS, now);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const sessions: Array<{ at: number; session: WorkoutSession }> = [];
  for (const row of rows) {
    const parsed = WorkoutSessionSchema.safeParse(row);
    if (!parsed.success) continue;
    const at = Date.parse(parsed.data.startedAt);
    if (at >= fromMs && at < toMs) sessions.push({ at, session: parsed.data });
  }
  sessions.sort((a, b) => b.at - a.at);

  return {
    windowDays: COACH_CONTEXT_DAYS,
    totals: progression.totals,
    weeklySessions: progression.weeklyFrequency.map((week) => week.sessions),
    topExercises: progression.exercises.slice(0, COACH_MAX_RANKED_EXERCISES).map((exercise) => ({
      name: sanitizeExerciseName(exercise.name),
      sessionCount: exercise.sessionCount,
      totalVolumeKg: exercise.totalVolumeKg,
      bestEstimatedOneRepMaxKg: exercise.bestEstimatedOneRepMaxKg,
    })),
    recentSessions: sessions
      .slice(0, COACH_MAX_SESSIONS)
      .map(({ at, session }) => summariseSession(at, session)),
    truncated,
  };
}
