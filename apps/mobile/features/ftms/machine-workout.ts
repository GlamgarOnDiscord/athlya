/**
 * Logs a finished machine session as a workout — task 23.1, Requirement 12.1.
 *
 * The session goes through `POST /v1/sessions` (and the offline queue):
 * one exercise named after the machine type, one set carrying the
 * duration, the structured `cardio` summary (issue #667) and the same
 * summary as a readable line in `notes`.
 */
import { LogSessionRequestSchema, type LogSessionRequest } from '@athlya/shared/schemas/api';
import { CardioMetricsSchema, type CardioMetrics } from '@athlya/shared/schemas/domain';

import { toErrorModel, type ErrorModel } from '../errors';
import { formatNumber } from '../format';
import { LOG_SESSION_KIND, SESSIONS_PATH } from '../workouts/workout-form';
import { submitWrite, toJsonPayload, type WriteDeps } from '../writes';

import type { SessionSummary } from './live-session';
import type { MachineType } from './protocol';
import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

/** `SetSchema.durationSec` upper bound. */
const MAX_DURATION_SEC = 86_400;

export const MACHINE_NAME_KEYS: Readonly<Record<MachineType, TranslationKeys>> = {
  indoorBike: 'mobile.machine.types.indoorBike',
  treadmill: 'mobile.machine.types.treadmill',
  rower: 'mobile.machine.types.rower',
  crossTrainer: 'mobile.machine.types.crossTrainer',
};

export type Translate = (key: TranslationKeys, values?: Record<string, string | number>) => string;

/** "Distance 5.2 km · Avg power 182 W · …" from the metrics the machine reported. */
export function describeSummary(summary: SessionSummary, t: Translate, locale: Locale): string {
  const parts: string[] = [];
  if (summary.distanceM !== null) {
    parts.push(
      t('mobile.machine.summary.distance', {
        km: formatNumber(Math.round(summary.distanceM / 100) / 10, locale),
      }),
    );
  }
  if (summary.avgPowerW !== null) {
    parts.push(t('mobile.machine.summary.avgPower', { watts: summary.avgPowerW }));
  }
  if (summary.maxPowerW !== null) {
    parts.push(t('mobile.machine.summary.maxPower', { watts: summary.maxPowerW }));
  }
  if (summary.avgCadenceRpm !== null) {
    parts.push(t('mobile.machine.summary.avgCadence', { rpm: summary.avgCadenceRpm }));
  }
  if (summary.strokeCount !== null) {
    parts.push(t('mobile.machine.summary.strokes', { count: summary.strokeCount }));
  }
  if (summary.energyKcal !== null) {
    parts.push(t('mobile.machine.summary.energy', { kcal: summary.energyKcal }));
  }
  if (summary.avgHeartRateBpm !== null) {
    parts.push(t('mobile.machine.summary.avgHeartRate', { bpm: summary.avgHeartRateBpm }));
  }
  return parts.join(' · ');
}

/**
 * The structured summary sent as `cardio`. A metric outside the schema
 * bounds (a sensor glitch) is dropped on its own, so it never costs the
 * whole session.
 */
export function cardioMetricsOf(summary: SessionSummary, durationSec: number): CardioMetrics {
  const avgSpeedKmh =
    summary.distanceM !== null && durationSec > 0
      ? Math.round((summary.distanceM / durationSec) * 36) / 10
      : null;
  const candidates: { readonly [K in keyof CardioMetrics]-?: CardioMetrics[K] | null } = {
    machine: summary.machine,
    durationSec,
    distanceM: summary.distanceM,
    energyKcal: summary.energyKcal,
    avgPowerW: summary.avgPowerW,
    maxPowerW: summary.maxPowerW,
    avgCadenceRpm: summary.avgCadenceRpm,
    avgSpeedKmh,
    avgHeartRateBpm: summary.avgHeartRateBpm,
    maxHeartRateBpm: summary.maxHeartRateBpm,
    strokeCount: summary.strokeCount,
  };
  const metrics: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidates)) {
    const field = CardioMetricsSchema.shape[key as keyof CardioMetrics];
    if (value !== null && field.safeParse(value).success) metrics[key] = value;
  }
  return CardioMetricsSchema.parse(metrics);
}

/** The workout request for a summary, or null when nothing was recorded. */
export function buildMachineSessionRequest(
  summary: SessionSummary,
  t: Translate,
  locale: Locale,
): LogSessionRequest | null {
  if (summary.elapsedSec <= 0) return null;
  const durationSec = Math.min(summary.elapsedSec, MAX_DURATION_SEC);
  const notes = describeSummary(summary, t, locale);
  const parsed = LogSessionRequestSchema.safeParse({
    startedAt: new Date(summary.startedAtMs).toISOString(),
    durationMin: Math.max(1, Math.round(durationSec / 60)),
    exercises: [{ name: t(MACHINE_NAME_KEYS[summary.machine]), sets: [{ reps: 0, durationSec }] }],
    cardio: cardioMetricsOf(summary, durationSec),
    ...(notes === '' ? {} : { notes }),
  });
  return parsed.success ? parsed.data : null;
}

export type SaveMachineSessionResult =
  | { readonly kind: 'sent' | 'queued' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: ErrorModel };

export async function saveMachineSession(
  writes: WriteDeps,
  request: LogSessionRequest | null,
  signal?: AbortSignal,
): Promise<SaveMachineSessionResult> {
  if (request === null) return { kind: 'empty' };
  try {
    const outcome = await submitWrite<unknown>(writes, {
      kind: LOG_SESSION_KIND,
      method: 'POST',
      path: SESSIONS_PATH,
      payload: toJsonPayload(request),
      ...(signal === undefined ? {} : { signal }),
    });
    return { kind: outcome.kind };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { kind: 'error', error: toErrorModel(error) };
  }
}
