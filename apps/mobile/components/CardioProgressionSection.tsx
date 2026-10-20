import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import { formatNumber } from '../features/format';
import {
  distanceSeries,
  distanceSummary,
  powerSeries,
  speedSeries,
  trendSummary,
} from '../features/progression/cardio-progression-charts';
import {
  CARDIO_BUCKETS,
  cardioSectionView,
  type CardioProgressionController,
} from '../features/progression/cardio-progression-controller';
import { windowBounds, type SummaryFormat } from '../features/progression/progression-charts';

import { ErrorNotice } from './ErrorNotice';
import { SeriesChart } from './SeriesChart';
import { AppText } from './ui/AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { ChoiceGroup } from './ui/ChoiceGroup';

import type { ErrorModel } from '../features/errors';
import type { Message } from '../features/programs/today-program';
import type { AppRuntime } from '../infrastructure/runtime';
import type {
  CardioMachineProgression,
  CardioProgressionBucket,
  CardioProgressionResponse,
} from '@athlya/shared/schemas/api';

interface SectionContext {
  readonly t: AppRuntime['t'];
  readonly locale: AppRuntime['locale'];
  readonly format: SummaryFormat;
}

export interface CardioProgressionSectionProps extends SectionContext {
  readonly controller: CardioProgressionController;
}

/**
 * Cardio section of the progression screen (issue #683): distance per
 * day or week, and the average power and speed of each session, for the
 * machine picked. A Worker without the endpoint (404) shows the section
 * as unavailable; other failures show the error with a retry.
 */
export function CardioProgressionSection({
  controller,
  t,
  locale,
  format,
}: CardioProgressionSectionProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const view = cardioSectionView(state);
  const error: ErrorModel | null =
    view.kind === 'error' ? view.error : view.kind === 'data' ? view.error : null;

  return (
    <View className="gap-md">
      <Text
        accessibilityRole="header"
        className="text-2xl font-semibold text-foreground dark:text-dark-foreground"
      >
        {t('workouts.progression.cardio.title')}
      </Text>
      <AppText variant="muted">{t('workouts.progression.cardio.description')}</AppText>

      <ChoiceGroup<CardioProgressionBucket>
        label={t('mobile.progression.cardio.bucketLabel')}
        hint={t('mobile.progression.cardio.bucketHint')}
        choices={CARDIO_BUCKETS.map((value) => ({
          value,
          label: t(`workouts.progression.cardio.bucket.${value}`),
        }))}
        value={state.bucket}
        onChange={(value) => {
          void controller.selectBucket(value);
        }}
      />

      {view.kind === 'loading' ? <AppText variant="muted">{t('common.loading')}</AppText> : null}

      {view.kind === 'unavailable' ? (
        <AppText variant="muted">{t('workouts.progression.cardio.unavailable')}</AppText>
      ) : null}

      {error === null ? null : (
        <>
          <ErrorNotice error={error} />
          {error.authRequired ? null : (
            <Button
              title={t('common.retry')}
              variant="secondary"
              onPress={() => {
                void controller.load();
              }}
            />
          )}
        </>
      )}

      {view.kind === 'empty' ? (
        <AppText variant="muted">{t('workouts.progression.cardio.empty')}</AppText>
      ) : null}

      {view.kind === 'data' ? (
        <MachineCharts
          data={view.data}
          machine={view.machine}
          onSelectMachine={(machine) => {
            controller.selectMachine(machine);
          }}
          t={t}
          locale={locale}
          format={format}
        />
      ) : null}
    </View>
  );
}

interface MachineChartsProps extends SectionContext {
  readonly data: CardioProgressionResponse;
  readonly machine: CardioMachineProgression;
  readonly onSelectMachine: (machine: CardioMachineProgression['machine']) => void;
}

function MachineCharts({ data, machine, onSelectMachine, t, locale, format }: MachineChartsProps) {
  const say = (message: Message | null): string =>
    message === null ? '' : t(message.key, { ...message.values });
  const duration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0
      ? t('workouts.progression.cardio.units.hoursMinutes', { hours, minutes })
      : t('workouts.progression.cardio.units.minutes', { minutes });
  };

  const name = t(`workouts.progression.cardio.machines.${machine.machine}`);
  const byWeek = data.bucket === 'week';
  const distance = distanceSeries(machine);
  const distanceText = distanceSummary(distance, format);
  const power = powerSeries(machine);
  const speed = speedSeries(machine);
  const domain: readonly [number, number] = [Date.parse(data.from), Date.parse(data.to)];
  const bounds = windowBounds(data.from, data.to);
  const axisLabels: readonly [string, string] = [format.day(bounds[0]), format.day(bounds[1])];
  const firstPeriod = distance[0];
  const lastPeriod = distance[distance.length - 1];
  const distanceAxis: readonly [string, string] = [
    firstPeriod === undefined ? '' : format.day(firstPeriod.date),
    lastPeriod === undefined ? '' : format.day(lastPeriod.date),
  ];
  const stats: ReadonlyArray<readonly [string, string]> = [
    [t('workouts.progression.cardio.summary.sessions'), formatNumber(machine.sessionCount, locale)],
    [
      t('workouts.progression.cardio.summary.distance'),
      t('workouts.progression.cardio.units.km', {
        value: formatNumber(machine.totals.distanceM / 1000, locale),
      }),
    ],
    [t('workouts.progression.cardio.summary.duration'), duration(machine.totals.durationSec)],
    [
      t('workouts.progression.cardio.summary.energy'),
      t('workouts.progression.cardio.units.kcal', {
        value: formatNumber(machine.totals.energyKcal, locale),
      }),
    ],
  ];

  return (
    <>
      <ChoiceGroup<CardioMachineProgression['machine']>
        label={t('mobile.progression.cardio.machineLabel')}
        hint={t('mobile.progression.cardio.machineHint')}
        choices={data.machines.map((item) => ({
          value: item.machine,
          label: t(`workouts.progression.cardio.machines.${item.machine}`),
        }))}
        value={machine.machine}
        onChange={onSelectMachine}
      />

      <Card>
        {stats.map(([label, value]) => (
          <View key={label} accessible accessibilityLabel={`${label}: ${value}`}>
            <AppText variant="muted">{label}</AppText>
            <AppText className="text-2xl font-semibold">{value}</AppText>
          </View>
        ))}
      </Card>

      {data.truncated ? (
        <AppText variant="muted">{t('workouts.progression.truncated')}</AppText>
      ) : null}

      {distanceText === null ? (
        <AppText variant="muted">{t('workouts.progression.cardio.distance.empty')}</AppText>
      ) : (
        <SeriesChart
          kind="bar"
          title={t(
            byWeek
              ? 'workouts.progression.cardio.distance.titleWeek'
              : 'workouts.progression.cardio.distance.titleDay',
            { machine: name },
          )}
          description={t('workouts.progression.cardio.distance.description')}
          points={distance}
          summary={say(distanceText)}
          axisLabels={distanceAxis}
          formatTick={format.number}
        />
      )}

      {power.length > 0 ? (
        <SeriesChart
          kind="line"
          title={t('workouts.progression.cardio.power.title', { machine: name })}
          description={t('workouts.progression.cardio.power.description')}
          points={power}
          summary={say(trendSummary(power, format, 'mobile.progression.cardio.powerSummary'))}
          xDomain={domain}
          axisLabels={axisLabels}
          formatTick={format.number}
        />
      ) : (
        <AppText variant="muted">{t('workouts.progression.cardio.power.empty')}</AppText>
      )}

      {speed.length > 0 ? (
        <SeriesChart
          kind="line"
          title={t('workouts.progression.cardio.speed.title', { machine: name })}
          description={t('workouts.progression.cardio.speed.description')}
          points={speed}
          summary={say(trendSummary(speed, format, 'mobile.progression.cardio.speedSummary'))}
          xDomain={domain}
          axisLabels={axisLabels}
          formatTick={format.number}
        />
      ) : (
        <AppText variant="muted">{t('workouts.progression.cardio.speed.empty')}</AppText>
      )}
    </>
  );
}
