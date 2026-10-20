/**
 * Pure models behind the cardio progression charts (issue #683): the
 * series read from the API body, drawn by `components/SeriesChart.tsx`
 * with the same layout as the strength charts, and the spoken summary
 * every chart carries as its accessibility label.
 */
import { dayMs } from '@athlya/shared/charts';

import type { SeriesPoint, SummaryFormat } from './progression-charts';
import type { Message } from '../programs/today-program';
import type { TranslationKeys } from '@athlya/shared/i18n';
import type { CardioMachineProgression, CardioSessionPoint } from '@athlya/shared/schemas/api';

/** Distance in km per bucket (UTC day or ISO week), oldest first, zero-filled by the API. */
export function distanceSeries(machine: CardioMachineProgression): SeriesPoint[] {
  return machine.series.map((bucket) => ({
    key: bucket.periodStart,
    date: bucket.periodStart,
    x: dayMs(bucket.periodStart),
    value: bucket.distanceM / 1000,
  }));
}

function sessionSeries(
  machine: CardioMachineProgression,
  pick: (point: CardioSessionPoint) => number | null,
): SeriesPoint[] {
  return machine.points.flatMap((point, index) => {
    const value = pick(point);
    return value === null
      ? []
      : [
          {
            key: `${point.startedAt}-${String(index)}`,
            date: point.startedAt.slice(0, 10),
            x: Date.parse(point.startedAt),
            value,
          },
        ];
  });
}

/** Average power of each session that reported it, in W. */
export function powerSeries(machine: CardioMachineProgression): SeriesPoint[] {
  return sessionSeries(machine, (point) => point.avgPowerW);
}

/** Average speed of each session that reported it, in km/h. */
export function speedSeries(machine: CardioMachineProgression): SeriesPoint[] {
  return sessionSeries(machine, (point) => point.avgSpeedKmh);
}

/**
 * What a screen reader says for the distance chart: the number of
 * periods, the total, the longest period and the latest one. `null`
 * when the machine reported no distance (the screen says so instead).
 */
export function distanceSummary(
  points: readonly SeriesPoint[],
  format: SummaryFormat,
): Message | null {
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const first = points[0];
  const last = points[points.length - 1];
  if (total === 0 || first === undefined || last === undefined) return null;
  return {
    key: 'mobile.progression.cardio.distanceSummary',
    values: {
      count: points.length,
      from: format.day(first.date),
      to: format.day(last.date),
      total: format.number(total),
      max: format.number(Math.max(...points.map((point) => point.value))),
      latest: format.number(last.value),
    },
  };
}

/**
 * What a screen reader says for a power or speed trend: how many
 * sessions, over which dates, and the latest, highest and lowest values.
 * `null` when no session reported the metric.
 */
export function trendSummary(
  points: readonly SeriesPoint[],
  format: SummaryFormat,
  key: Extract<
    TranslationKeys,
    'mobile.progression.cardio.powerSummary' | 'mobile.progression.cardio.speedSummary'
  >,
): Message | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const values = points.map((point) => point.value);
  return {
    key,
    values: {
      count: points.length,
      from: format.day(first.date),
      to: format.day(last.date),
      latest: format.number(last.value),
      max: format.number(Math.max(...values)),
      min: format.number(Math.min(...values)),
    },
  };
}
