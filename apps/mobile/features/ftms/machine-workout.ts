/**
 * Logs a finished machine session as a workout — task 23.1, Requirement 12.1.
 *
 * The session goes through the existing `POST /v1/sessions` contract (and
 * the offline queue) without an API change: one exercise named after the
 * machine type, one set carrying the duration, and the cardio summary as
 * a readable line in `notes`. Structured cardio fields are a follow-up.
 */
import { LogSessionRequestSchema, type LogSessionRequest } from '@athlya/shared/schemas/api';

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
