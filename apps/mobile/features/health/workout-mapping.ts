/**
 * Apple Health workout → `POST /v1/sessions` request — task 18.1,
 * Requirement 12.1.
 *
 * Like a machine session (task 23.1), an imported workout is one exercise
 * named after the activity type with one set carrying the duration, and
 * a readable line of totals in `notes`. `source` names the HealthKit
 * workout, so the API keeps one session per workout and user.
 */
import {
  LogSessionRequestSchema,
  type LogSessionRequest,
  type SessionSourceProvider,
} from '@athlya/shared/schemas/api';

import { formatNumber } from '../format';

import type { HealthQuantity, HealthWorkout } from '../../infrastructure/health/ports';
import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export const APPLE_HEALTH_PROVIDER: SessionSourceProvider = 'appleHealth';

/** `SetSchema.durationSec` upper bound. */
const MAX_DURATION_SEC = 86_400;

export type Translate = (key: TranslationKeys, values?: Record<string, string | number>) => string;

/** Names of the common `HKWorkoutActivityType` raw values; others read "Workout". */
const ACTIVITY_KEYS: ReadonlyMap<number, TranslationKeys> = new Map<number, TranslationKeys>([
  [11, 'mobile.health.activities.crossTraining'],
  [13, 'mobile.health.activities.cycling'],
  [14, 'mobile.health.activities.dance'],
  [16, 'mobile.health.activities.elliptical'],
  [20, 'mobile.health.activities.strength'],
  [24, 'mobile.health.activities.hiking'],
  [35, 'mobile.health.activities.rowing'],
  [37, 'mobile.health.activities.running'],
  [44, 'mobile.health.activities.stairs'],
  [46, 'mobile.health.activities.swimming'],
  [50, 'mobile.health.activities.strength'],
  [52, 'mobile.health.activities.walking'],
  [57, 'mobile.health.activities.yoga'],
  [59, 'mobile.health.activities.core'],
  [63, 'mobile.health.activities.hiit'],
  [66, 'mobile.health.activities.pilates'],
  [68, 'mobile.health.activities.stairs'],
  [73, 'mobile.health.activities.mixedCardio'],
  [77, 'mobile.health.activities.dance'],
]);

export function activityNameKey(activityType: number): TranslationKeys {
  return ACTIVITY_KEYS.get(activityType) ?? 'mobile.health.activities.other';
}

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = { s: 1, ms: 0.001, min: 60, hr: 3600 };
const METRES_PER_UNIT: Readonly<Record<string, number>> = {
  m: 1,
  cm: 0.01,
  km: 1000,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
};
const KCAL_PER_UNIT: Readonly<Record<string, number>> = {
  kcal: 1,
  Cal: 1,
  cal: 0.001,
  kJ: 1 / 4.184,
  J: 1 / 4184,
};

/** The quantity in the target unit, or null for an unknown unit or a non-positive value. */
function convert(
  quantity: HealthQuantity | undefined,
  factors: Readonly<Record<string, number>>,
): number | null {
  if (quantity === undefined || !Object.hasOwn(factors, quantity.unit)) return null;
  const value = quantity.quantity * (factors[quantity.unit] ?? Number.NaN);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A positive, finite heart rate rounded to a whole bpm, or null. */
function bpm(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 && rounded < 300 ? rounded : null;
}

/** "Imported from Apple Health · Distance 5.2 km · Energy 320 kcal · …". */
export function describeHealthWorkout(
  workout: HealthWorkout,
  t: Translate,
  locale: Locale,
): string {
  const parts = [t('mobile.health.summary.source')];
  const distanceM = convert(workout.totalDistance, METRES_PER_UNIT);
  const km = distanceM === null ? 0 : Math.round(distanceM / 100) / 10;
  if (km > 0) {
    parts.push(t('mobile.health.summary.distance', { km: formatNumber(km, locale) }));
  }
  const energyKcal = convert(workout.totalEnergyBurned, KCAL_PER_UNIT);
  if (energyKcal !== null && Math.round(energyKcal) > 0) {
    parts.push(t('mobile.health.summary.energy', { kcal: Math.round(energyKcal) }));
  }
  const avg = bpm(workout.averageHeartRateBpm);
  if (avg !== null) parts.push(t('mobile.health.summary.avgHeartRate', { bpm: avg }));
  const max = bpm(workout.maxHeartRateBpm);
  if (max !== null) parts.push(t('mobile.health.summary.maxHeartRate', { bpm: max }));
  return parts.join(' · ');
}

/** Workout duration in whole seconds, from its duration or else its dates. */
function durationSeconds(workout: HealthWorkout): number {
  const fromQuantity = convert(workout.duration, SECONDS_PER_UNIT);
  const seconds = fromQuantity ?? (workout.endDate.getTime() - workout.startDate.getTime()) / 1000;
  return Number.isFinite(seconds) ? Math.min(Math.round(seconds), MAX_DURATION_SEC) : 0;
}

/** The session request for a workout, or null when it cannot be one (no duration, bad date). */
export function buildHealthSessionRequest(
  workout: HealthWorkout,
  t: Translate,
  locale: Locale,
): LogSessionRequest | null {
  const startMs = workout.startDate.getTime();
  if (!Number.isFinite(startMs)) return null;
  const durationSec = durationSeconds(workout);
  if (durationSec <= 0) return null;
  const parsed = LogSessionRequestSchema.safeParse({
    startedAt: new Date(startMs).toISOString(),
    durationMin: Math.max(1, Math.round(durationSec / 60)),
    exercises: [
      { name: t(activityNameKey(workout.activityType)), sets: [{ reps: 0, durationSec }] },
    ],
    notes: describeHealthWorkout(workout, t, locale),
    source: { provider: APPLE_HEALTH_PROVIDER, externalId: workout.uuid },
  });
  return parsed.success ? parsed.data : null;
}

/** Hex SHA-256 of a UTF-8 string (`expo-crypto` on device, `node:crypto` in tests). */
export type Sha256Hex = (input: string) => Promise<string>;

/**
 * The `Idempotency-Key` of an imported workout: the SHA-256 of the
 * provider and workout id, laid out as a UUID v4 (the offline queue only
 * stores v4 keys). The same workout always gets the same key, on every
 * run and device, so a re-import replays instead of writing again.
 */
export async function importIdempotencyKey(
  sha256: Sha256Hex,
  provider: SessionSourceProvider,
  externalId: string,
): Promise<string> {
  const hex = (await sha256(`athlya:${provider}:${externalId}`)).toLowerCase();
  if (!/^[0-9a-f]{32,}$/u.test(hex)) throw new Error('sha256 must return a hex digest');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
