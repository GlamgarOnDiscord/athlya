/**
 * Members service — cardio progression aggregator (issue #683).
 *
 * Turns the structured `cardio` summary of a member's workout sessions
 * (migration 0046, {@link CardioMetricsSchema}) into per-machine series
 * over a 30, 90 or 365-day window: per-day or per-ISO-week moving time,
 * distance, energy, average power and average heart rate, plus one
 * point per session for the power / speed trend lines.
 *
 * It is served by its own endpoint, `GET /v1/me/progression/cardio`,
 * so the strict `GET /v1/me/progression` contract parsed by installed
 * mobile builds stays unchanged.
 *
 * Window and buckets
 * ------------------
 * Same window as {@link computeProgression}: `windowDays` whole UTC days
 * ending with today, `[from, to)`. Days are UTC calendar days and weeks
 * start on Monday (UTC), like `weeklyFrequency`. Every series is
 * zero-filled from the bucket containing `from` to the one containing
 * today, so a week starting before `from` is listed with only the
 * sessions inside the window.
 *
 * Averages
 * --------
 * A bucket's `avgPowerW` / `avgHeartRateBpm` is the mean of the
 * sessions' averages weighted by their moving time (`durationSec`), so a
 * 60-minute ride counts four times a 15-minute one. When none of the
 * sessions reporting the metric reported a positive duration, the plain
 * mean is used instead. `null` means no session reported the metric.
 *
 * {@link computeCardioProgression} is pure; {@link getCardioProgression}
 * reads through a {@link CardioProgressionRepo}, whose concrete adapter
 * runs under the caller's RLS context.
 */

import {
  CARDIO_PROGRESSION_BUCKETS,
  CARDIO_PROGRESSION_MACHINES,
} from '@athlya/shared/schemas/api';
import { CardioMetricsSchema } from '@athlya/shared/schemas/domain';

import {
  PROGRESSION_SESSION_LIMIT,
  isProgressionWindow,
  progressionWindowBounds,
} from './progression.js';
import { MembersError } from './service.js';

import type { ListProgressionSessionsOptions } from './progression.js';
import type {
  CardioMachineProgression,
  CardioProgressionBucket,
  CardioProgressionMachine,
  CardioProgressionResponse,
  CardioSeriesBucket,
  CardioSessionPoint,
  ProgressionWindow,
} from '@athlya/shared/schemas/api';
import type { CardioMetrics } from '@athlya/shared/schemas/domain';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/** One stored session with a cardio summary, as the repo returns it. */
export interface CardioSessionRow {
  /** ISO 8601 UTC timestamp of `workout_sessions.started_at`. */
  readonly startedAt: unknown;
  /** Raw `workout_sessions.cardio` jsonb value. */
  readonly cardio: unknown;
}

/**
 * Read port for the cardio progression use case. Implementations
 * return the caller's sessions with a non-null `cardio` and `startedAt`
 * in `[from, to)`, newest first, at most `limit` rows.
 */
export interface CardioProgressionRepo {
  listCardioInWindow(
    userId: string,
    opts: ListProgressionSessionsOptions,
  ): Promise<readonly CardioSessionRow[]>;
}

export interface CardioProgressionServiceDeps {
  repo: CardioProgressionRepo;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function startOfIsoWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY_MS;
}

/** True when `value` is one of {@link CARDIO_PROGRESSION_BUCKETS}. */
export function isCardioProgressionBucket(value: unknown): value is CardioProgressionBucket {
  return (CARDIO_PROGRESSION_BUCKETS as readonly unknown[]).includes(value);
}

/** Epoch ms of the start of the bucket containing `ms`. */
export function cardioBucketStart(bucket: CardioProgressionBucket, ms: number): number {
  return bucket === 'day' ? startOfUtcDay(ms) : startOfIsoWeek(ms);
}

/* ------------------------------------------------------------------ */
/*  Aggregation                                                        */
/* ------------------------------------------------------------------ */

/** Running weighted mean: Σ value × weight and Σ weight, plus a plain fallback. */
interface MeanAccumulator {
  weighted: number;
  weight: number;
  plain: number;
  count: number;
}

function emptyMean(): MeanAccumulator {
  return { weighted: 0, weight: 0, plain: 0, count: 0 };
}

function addToMean(acc: MeanAccumulator, value: number | undefined, durationSec: number): void {
  if (value === undefined) return;
  acc.plain += value;
  acc.count += 1;
  if (durationSec > 0) {
    acc.weighted += value * durationSec;
    acc.weight += durationSec;
  }
}

function meanOrNull(acc: MeanAccumulator): number | null {
  if (acc.count === 0) return null;
  return round1(acc.weight > 0 ? acc.weighted / acc.weight : acc.plain / acc.count);
}

interface BucketAccumulator {
  sessions: number;
  durationSec: number;
  distanceM: number;
  energyKcal: number;
  power: MeanAccumulator;
  heartRate: MeanAccumulator;
}

interface MachineAccumulator {
  durationSec: number;
  distanceM: number;
  energyKcal: number;
  buckets: Map<number, BucketAccumulator>;
  points: CardioSessionPoint[];
}

export interface ComputeCardioProgressionOptions {
  readonly windowDays: ProgressionWindow;
  readonly bucket: CardioProgressionBucket;
  /** Reference clock, epoch ms. */
  readonly now: number;
  /** Set when the repo had more rows than it returned. */
  readonly truncated?: boolean;
}

/**
 * Aggregate `rows` into the cardio progression response for the window
 * ending today (UTC). Pure: same input, same output.
 *
 * A row whose `startedAt` is not a parseable timestamp or whose `cardio`
 * fails {@link CardioMetricsSchema} is counted in `skippedSessions`;
 * a row with a null `cardio` or outside the window is ignored.
 */
export function computeCardioProgression(
  rows: readonly CardioSessionRow[],
  opts: ComputeCardioProgressionOptions,
): CardioProgressionResponse {
  const { from, to } = progressionWindowBounds(opts.windowDays, opts.now);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  let skippedSessions = 0;
  const sessions: Array<{ at: number; startedAt: string; cardio: CardioMetrics }> = [];
  for (const row of rows) {
    if (row.cardio === null || row.cardio === undefined) continue;
    const at = typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : Number.NaN;
    const cardio = CardioMetricsSchema.safeParse(row.cardio);
    if (!Number.isFinite(at) || !cardio.success) {
      skippedSessions += 1;
      continue;
    }
    if (at >= fromMs && at < toMs) {
      sessions.push({ at, startedAt: new Date(at).toISOString(), cardio: cardio.data });
    }
  }
  sessions.sort((a, b) => a.at - b.at);

  const machines = new Map<CardioProgressionMachine, MachineAccumulator>();
  const totals = { sessions: 0, durationSec: 0, distanceM: 0, energyKcal: 0 };

  for (const { at, startedAt, cardio } of sessions) {
    const key: CardioProgressionMachine = cardio.machine ?? 'unspecified';
    let machine = machines.get(key);
    if (machine === undefined) {
      machine = { durationSec: 0, distanceM: 0, energyKcal: 0, buckets: new Map(), points: [] };
      machines.set(key, machine);
    }
    const durationSec = cardio.durationSec ?? 0;
    const distanceM = cardio.distanceM ?? 0;
    const energyKcal = cardio.energyKcal ?? 0;

    totals.sessions += 1;
    totals.durationSec += durationSec;
    totals.distanceM += distanceM;
    totals.energyKcal += energyKcal;
    machine.durationSec += durationSec;
    machine.distanceM += distanceM;
    machine.energyKcal += energyKcal;

    const start = cardioBucketStart(opts.bucket, at);
    let bucket = machine.buckets.get(start);
    if (bucket === undefined) {
      bucket = {
        sessions: 0,
        durationSec: 0,
        distanceM: 0,
        energyKcal: 0,
        power: emptyMean(),
        heartRate: emptyMean(),
      };
      machine.buckets.set(start, bucket);
    }
    bucket.sessions += 1;
    bucket.durationSec += durationSec;
    bucket.distanceM += distanceM;
    bucket.energyKcal += energyKcal;
    addToMean(bucket.power, cardio.avgPowerW, durationSec);
    addToMean(bucket.heartRate, cardio.avgHeartRateBpm, durationSec);

    machine.points.push({
      startedAt,
      durationSec: cardio.durationSec ?? null,
      distanceM: cardio.distanceM ?? null,
      avgPowerW: cardio.avgPowerW ?? null,
      avgSpeedKmh: cardio.avgSpeedKmh ?? null,
      avgHeartRateBpm: cardio.avgHeartRateBpm ?? null,
    });
  }

  const step = opts.bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  const firstBucket = cardioBucketStart(opts.bucket, fromMs);

  const result: CardioMachineProgression[] = [];
  for (const key of CARDIO_PROGRESSION_MACHINES) {
    const machine = machines.get(key);
    if (machine === undefined) continue;
    const series: CardioSeriesBucket[] = [];
    for (let start = firstBucket; start < toMs; start += step) {
      const bucket = machine.buckets.get(start);
      series.push({
        periodStart: utcDay(start),
        sessions: bucket?.sessions ?? 0,
        durationSec: bucket?.durationSec ?? 0,
        distanceM: bucket?.distanceM ?? 0,
        energyKcal: bucket?.energyKcal ?? 0,
        avgPowerW: bucket === undefined ? null : meanOrNull(bucket.power),
        avgHeartRateBpm: bucket === undefined ? null : meanOrNull(bucket.heartRate),
      });
    }
    result.push({
      machine: key,
      sessionCount: machine.points.length,
      totals: {
        durationSec: machine.durationSec,
        distanceM: machine.distanceM,
        energyKcal: machine.energyKcal,
      },
      series,
      points: machine.points,
    });
  }

  return {
    windowDays: opts.windowDays,
    from: from.toISOString(),
    to: to.toISOString(),
    bucket: opts.bucket,
    totals,
    machines: result,
    truncated: opts.truncated === true,
    skippedSessions,
  };
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cardio progression of `userId` over the last `windowDays` UTC days,
 * bucketed per UTC day or ISO week.
 *
 * Reads at most {@link PROGRESSION_SESSION_LIMIT} sessions with a cardio
 * summary (newest first) and flags the response `truncated` when more
 * exist.
 *
 * Throws {@link MembersError} `validation_failed` when `windowDays` is
 * not 30, 90 or 365, or `bucket` is not `day` or `week`.
 */
export async function getCardioProgression(
  userId: string,
  windowDays: unknown,
  bucket: unknown,
  deps: CardioProgressionServiceDeps,
): Promise<CardioProgressionResponse> {
  if (!isProgressionWindow(windowDays)) {
    throw new MembersError('validation_failed', 'window must be one of 30, 90 or 365', [
      { path: 'window', code: 'invalid_value', message: 'must be one of 30, 90 or 365' },
    ]);
  }
  if (!isCardioProgressionBucket(bucket)) {
    throw new MembersError('validation_failed', 'bucket must be day or week', [
      { path: 'bucket', code: 'invalid_value', message: 'must be day or week' },
    ]);
  }
  const now = (deps.now ?? Date.now)();
  const bounds = progressionWindowBounds(windowDays, now);
  const rows = await deps.repo.listCardioInWindow(userId, {
    ...bounds,
    limit: PROGRESSION_SESSION_LIMIT + 1,
  });
  const truncated = rows.length > PROGRESSION_SESSION_LIMIT;
  return computeCardioProgression(truncated ? rows.slice(0, PROGRESSION_SESSION_LIMIT) : rows, {
    windowDays,
    bucket,
    now,
    truncated,
  });
}
