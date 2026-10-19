/**
 * Display rows for the live machine screen: only the metrics the machine
 * has reported, labelled and formatted for the member's locale.
 */
import { formatNumber } from '../format';

import { summarise, type LiveSession } from './live-session';

import type { Translate } from './machine-workout';
import type { Locale } from '@athlya/shared/i18n';

export interface MetricRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** "4:05" or "1:02:03". */
export function formatElapsed(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3_600);
  const minutes = Math.floor((sec % 3_600) / 60);
  const seconds = String(sec % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}

export function liveMetricRows(
  session: LiveSession,
  nowMs: number,
  t: Translate,
  locale: Locale,
): readonly MetricRow[] {
  const { latest } = session;
  const summary = summarise(session, nowMs);
  const rows: MetricRow[] = [
    {
      key: 'elapsed',
      label: t('mobile.machine.metrics.elapsed'),
      value: formatElapsed(summary.elapsedSec),
    },
  ];
  const push = (key: string, label: Parameters<Translate>[0], value: string): void => {
    rows.push({ key, label: t(label), value });
  };
  if (latest.speedKmh !== undefined) {
    push(
      'speed',
      'mobile.machine.metrics.speed',
      t('mobile.machine.metrics.unit.kmh', { value: formatNumber(latest.speedKmh, locale) }),
    );
  }
  if (latest.cadenceRpm !== undefined) {
    push(
      'cadence',
      'mobile.machine.metrics.cadence',
      t('mobile.machine.metrics.unit.rpm', { value: Math.round(latest.cadenceRpm) }),
    );
  }
  if (latest.strokeRatePerMin !== undefined) {
    push(
      'strokeRate',
      'mobile.machine.metrics.strokeRate',
      t('mobile.machine.metrics.unit.spm', {
        value: formatNumber(latest.strokeRatePerMin, locale),
      }),
    );
  }
  if (latest.powerW !== undefined) {
    push(
      'power',
      'mobile.machine.metrics.power',
      t('mobile.machine.metrics.unit.watts', { value: latest.powerW }),
    );
  }
  if (latest.inclinePct !== undefined) {
    push(
      'incline',
      'mobile.machine.metrics.incline',
      t('mobile.machine.metrics.unit.percent', { value: formatNumber(latest.inclinePct, locale) }),
    );
  }
  if (summary.distanceM !== null) {
    push(
      'distance',
      'mobile.machine.metrics.distance',
      t('mobile.machine.metrics.unit.km', {
        value: formatNumber(Math.round(summary.distanceM / 100) / 10, locale),
      }),
    );
  }
  if (summary.energyKcal !== null) {
    push(
      'energy',
      'mobile.machine.metrics.energy',
      t('mobile.machine.metrics.unit.kcal', { value: summary.energyKcal }),
    );
  }
  if (latest.heartRateBpm !== undefined) {
    push(
      'heartRate',
      session.heartRateSource === 'strap'
        ? 'mobile.machine.metrics.heartRateStrap'
        : 'mobile.machine.metrics.heartRate',
      t('mobile.machine.metrics.unit.bpm', { value: latest.heartRateBpm }),
    );
  }
  return rows;
}
