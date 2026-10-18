import { Stack } from 'expo-router';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { SignedIn } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { SeriesChart } from '../components/SeriesChart';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ChoiceGroup } from '../components/ui/ChoiceGroup';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { formatNumber, formatUtcDay } from '../features/format';
import {
  frequencySeries,
  frequencySummary,
  lineSummary,
  oneRepMaxSeries,
  volumeSeries,
  windowBounds,
  type SummaryFormat,
} from '../features/progression/progression-charts';
import {
  PROGRESSION_WINDOWS,
  ProgressionController,
  selectedExercise,
  type ProgressionWindow,
} from '../features/progression/progression-controller';

import type { Message } from '../features/programs/today-program';

const WINDOW_KEYS = {
  30: 'workouts.progression.window.d30',
  90: 'workouts.progression.window.d90',
  365: 'workouts.progression.window.d365',
} as const;

function Progression() {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const controller = useMemo(() => new ProgressionController(runtime.api), [runtime]);
  const state = useSyncExternalStore(controller.subscribe, controller.get);

  // Unmounting cancels whichever load is in flight, including a window switch.
  useEffect(() => {
    void controller.load();
    return () => {
      controller.cancel();
    };
  }, [controller]);

  const format: SummaryFormat = useMemo(
    () => ({
      day: (date) => formatUtcDay(date, locale),
      number: (value) => formatNumber(value, locale),
    }),
    [locale],
  );
  const say = (message: Message | null): string =>
    message === null ? '' : t(message.key, { ...message.values });
  const kg = (value: number): string =>
    t('mobile.progression.kg', { value: formatNumber(value, locale) });

  const { data } = state;
  const exercise = data === null ? undefined : selectedExercise(data, state.exerciseKey);
  const domain: readonly [number, number] | undefined =
    data === null ? undefined : [Date.parse(data.from), Date.parse(data.to)];
  const bounds = data === null ? null : windowBounds(data.from, data.to);
  const axisLabels: readonly [string, string] =
    bounds === null ? ['', ''] : [format.day(bounds[0]), format.day(bounds[1])];

  const volume = exercise === undefined ? [] : volumeSeries(exercise);
  const oneRepMax = exercise === undefined ? [] : oneRepMaxSeries(exercise);
  const frequency = data === null ? [] : frequencySeries(data.weeklyFrequency);
  const frequencyText = frequencySummary(frequency, format);
  const firstWeek = frequency[0];
  const lastWeek = frequency[frequency.length - 1];
  const frequencyAxis: readonly [string, string] = [
    firstWeek === undefined ? '' : format.day(firstWeek.date),
    lastWeek === undefined ? '' : format.day(lastWeek.date),
  ];

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.progression.title') }} />
      <AppText variant="muted">{t('workouts.progression.description')}</AppText>

      <ChoiceGroup<ProgressionWindow>
        label={t('mobile.progression.windowLabel')}
        hint={t('mobile.progression.windowHint')}
        choices={PROGRESSION_WINDOWS.map((value) => ({ value, label: t(WINDOW_KEYS[value]) }))}
        value={state.windowDays}
        onChange={(value) => {
          void controller.selectWindow(value);
        }}
      />

      {state.load === 'loading' && data === null ? (
        <AppText variant="muted">{t('common.loading')}</AppText>
      ) : null}

      {state.error !== null ? (
        <>
          <ErrorNotice error={state.error} />
          {state.error.authRequired ? null : (
            <Button
              title={t('common.retry')}
              variant="secondary"
              onPress={() => {
                void controller.load();
              }}
            />
          )}
        </>
      ) : null}

      {data === null ? null : (
        <>
          <Card>
            <View
              accessible
              accessibilityLabel={`${t('workouts.progression.summary.sessions')}: ${formatNumber(data.totals.sessions, locale)}`}
            >
              <AppText variant="muted">{t('workouts.progression.summary.sessions')}</AppText>
              <AppText className="text-2xl font-semibold">
                {formatNumber(data.totals.sessions, locale)}
              </AppText>
            </View>
            <View
              accessible
              accessibilityLabel={`${t('workouts.progression.summary.volume')}: ${kg(data.totals.volumeKg)}`}
            >
              <AppText variant="muted">{t('workouts.progression.summary.volume')}</AppText>
              <AppText className="text-2xl font-semibold">{kg(data.totals.volumeKg)}</AppText>
            </View>
            {exercise !== undefined && exercise.bestEstimatedOneRepMaxKg !== null ? (
              <View
                accessible
                accessibilityLabel={`${t('mobile.progression.bestOneRepMax', { exercise: exercise.name })}: ${kg(exercise.bestEstimatedOneRepMaxKg)}`}
              >
                <AppText variant="muted">
                  {t('mobile.progression.bestOneRepMax', { exercise: exercise.name })}
                </AppText>
                <AppText className="text-2xl font-semibold">
                  {kg(exercise.bestEstimatedOneRepMaxKg)}
                </AppText>
              </View>
            ) : null}
          </Card>

          {data.truncated ? (
            <AppText variant="muted">{t('workouts.progression.truncated')}</AppText>
          ) : null}

          {exercise === undefined ? (
            <AppText variant="muted">{t('workouts.progression.empty')}</AppText>
          ) : (
            <>
              <ChoiceGroup<string>
                label={t('mobile.progression.exerciseLabel')}
                hint={t('mobile.progression.exerciseHint')}
                choices={data.exercises.map((item) => ({ value: item.key, label: item.name }))}
                value={exercise.key}
                onChange={(key) => {
                  controller.selectExercise(key);
                }}
              />

              {exercise.totalVolumeKg > 0 ? (
                <SeriesChart
                  kind="line"
                  title={t('workouts.progression.volume.title', { exercise: exercise.name })}
                  description={t('workouts.progression.volume.description')}
                  points={volume}
                  summary={say(lineSummary(volume, format))}
                  {...(domain === undefined ? {} : { xDomain: domain })}
                  axisLabels={axisLabels}
                  formatTick={format.number}
                />
              ) : (
                <AppText variant="muted">{t('workouts.progression.noWeight')}</AppText>
              )}

              {oneRepMax.length > 0 ? (
                <SeriesChart
                  kind="line"
                  title={t('workouts.progression.oneRepMax.title', { exercise: exercise.name })}
                  description={t('workouts.progression.oneRepMax.description')}
                  points={oneRepMax}
                  summary={say(lineSummary(oneRepMax, format))}
                  {...(domain === undefined ? {} : { xDomain: domain })}
                  axisLabels={axisLabels}
                  formatTick={format.number}
                />
              ) : (
                <AppText variant="muted">{t('workouts.progression.oneRepMax.empty')}</AppText>
              )}
            </>
          )}

          {frequencyText === null ? (
            <AppText variant="muted">{t('mobile.progression.chart.noSessions')}</AppText>
          ) : (
            <SeriesChart
              kind="bar"
              title={t('workouts.progression.frequency.title')}
              description={t('workouts.progression.frequency.description')}
              points={frequency}
              summary={say(frequencyText)}
              axisLabels={frequencyAxis}
              formatTick={format.number}
              integerScale
            />
          )}
        </>
      )}
    </ScrollScreen>
  );
}

export default function ProgressionScreen() {
  return <SignedIn>{() => <Progression />}</SignedIn>;
}
