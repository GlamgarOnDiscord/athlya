/**
 * `<ProgressionPanel />` — progression graphs (task 22.2, web).
 *
 * Fetches `GET /v1/me/progression?window=30|90|365` and renders three
 * accessible SVG charts (see `<SeriesChart />`):
 *   - a line chart of the daily volume of the selected exercise,
 *   - a line chart of its best estimated 1RM per day (Epley),
 *   - a bar chart of the weekly session frequency.
 *
 * The window is picked with a native radio group and the exercise with
 * a native `<select>`, so both work with the keyboard and assistive
 * technologies without extra ARIA. The same window drives the cardio
 * section (`<CardioProgressionSection />`), which fetches its own series.
 *
 * Layering mirrors `<ExportPanel />`: optional `client` and `t` props
 * are test seams; production derives both from context.
 *
 * @see Requirements 12.4, 27.1, 27.3, 28.1.
 */
'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

import { dayMs } from '../../../components/charts/chart-utils';
import { SeriesChart, type SeriesDatum } from '../../../components/charts/SeriesChart';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import { CardioProgressionSection } from './CardioProgressionSection';

import type { ApiClient } from '../../../lib/api/client';
import type { ProgressionResponse } from '@athlya/shared/schemas/api';

export interface ProgressionPanelProps {
  readonly t?: Translator;
  readonly client?: ApiClient;
}

type WindowValue = '30' | '90' | '365';

const WINDOWS: ReadonlyArray<{ value: WindowValue; key: 'd30' | 'd90' | 'd365' }> = [
  { value: '30', key: 'd30' },
  { value: '90', key: 'd90' },
  { value: '365', key: 'd365' },
];

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly data: ProgressionResponse };

export function ProgressionPanel({
  t: tProp,
  client: clientProp,
}: ProgressionPanelProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);
  const client = useApiClient(clientProp);

  const [windowDays, setWindowDays] = useState<WindowValue>('90');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [exerciseKey, setExerciseKey] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .get<ProgressionResponse>(`/v1/me/progression?window=${windowDays}`)
      .then((data) => {
        if (!cancelled) setStatus({ kind: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [client, windowDays, reloadNonce]);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [locale],
  );
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const formatDay = (date: string): string => dateFormat.format(dayMs(date));
  const formatKg = (value: number): string => numberFormat.format(value);

  const data = status.kind === 'ready' ? status.data : null;
  const exercise =
    data === null
      ? undefined
      : (data.exercises.find((e) => e.key === exerciseKey) ?? data.exercises[0]);

  const domain: readonly [number, number] | undefined =
    data === null ? undefined : [Date.parse(data.from), Date.parse(data.to)];
  const axisLabels: readonly [string, string] =
    data === null
      ? ['', '']
      : [
          dateFormat.format(Date.parse(data.from)),
          dateFormat.format(Date.parse(data.to) - HALF_DAY_MS),
        ];

  const volumeData: SeriesDatum[] =
    exercise?.points.map((p) => ({
      key: p.date,
      x: dayMs(p.date) + HALF_DAY_MS,
      value: p.volumeKg,
      xLabel: formatDay(p.date),
      label: t('workouts.progression.volume.point', {
        date: formatDay(p.date),
        value: formatKg(p.volumeKg),
      }),
    })) ?? [];

  const oneRepMaxData: SeriesDatum[] =
    exercise?.points.flatMap((p) =>
      p.estimatedOneRepMaxKg === null
        ? []
        : [
            {
              key: p.date,
              x: dayMs(p.date) + HALF_DAY_MS,
              value: p.estimatedOneRepMaxKg,
              xLabel: formatDay(p.date),
              label: t('workouts.progression.oneRepMax.point', {
                date: formatDay(p.date),
                value: formatKg(p.estimatedOneRepMaxKg),
              }),
            },
          ],
    ) ?? [];

  const frequencyData: SeriesDatum[] =
    data?.weeklyFrequency.map((w) => ({
      key: w.weekStart,
      x: dayMs(w.weekStart),
      value: w.sessions,
      xLabel: formatDay(w.weekStart),
      label: t('workouts.progression.frequency.point', {
        date: formatDay(w.weekStart),
        sessions:
          w.sessions === 1
            ? t('workouts.progression.frequency.sessionsOne')
            : t('workouts.progression.frequency.sessionsOther', { count: w.sessions }),
      }),
    })) ?? [];

  const keyboardHint = t('workouts.progression.keyboardHint');
  const selectId = 'progression-exercise';

  return (
    <section aria-labelledby="progression-heading" className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">{t('workouts.progression.description')}</p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          {t('workouts.progression.window.legend')}
        </legend>
        <div className="flex flex-wrap gap-2">
          {WINDOWS.map((w) => (
            <label
              key={w.value}
              className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="progression-window"
                value={w.value}
                checked={windowDays === w.value}
                onChange={() => {
                  setStatus({ kind: 'loading' });
                  setWindowDays(w.value);
                }}
                className="sr-only"
              />
              {t(`workouts.progression.window.${w.key}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {status.kind === 'loading' ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('common.loading')}
        </p>
      ) : null}

      {status.kind === 'error' ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-sm text-destructive">{t('errors.generic')}</p>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              setStatus({ kind: 'loading' });
              setReloadNonce((n) => n + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {data !== null ? (
        <div className="flex flex-col gap-10">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.summary.sessions')}
              </dt>
              <dd className="text-2xl font-semibold">
                {numberFormat.format(data.totals.sessions)}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.summary.volume')}
              </dt>
              <dd className="text-2xl font-semibold">
                {formatKg(data.totals.volumeKg)} {t('workouts.progression.table.kg')}
              </dd>
            </div>
            {exercise !== undefined && exercise.bestEstimatedOneRepMaxKg !== null ? (
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-muted-foreground">
                  {t('workouts.progression.summary.bestOneRepMax')} — {exercise.name}
                </dt>
                <dd className="text-2xl font-semibold">
                  {formatKg(exercise.bestEstimatedOneRepMaxKg)} {t('workouts.progression.table.kg')}
                </dd>
              </div>
            ) : null}
          </dl>

          {data.truncated ? (
            <p className="text-sm text-muted-foreground">{t('workouts.progression.truncated')}</p>
          ) : null}

          {exercise === undefined ? (
            <p className="text-sm text-muted-foreground">{t('workouts.progression.empty')}</p>
          ) : (
            <div className="flex flex-col gap-10">
              <div className="flex flex-col gap-2">
                <Label htmlFor={selectId}>{t('workouts.progression.exercise')}</Label>
                <select
                  id={selectId}
                  value={exercise.key}
                  onChange={(event) => {
                    setExerciseKey(event.target.value);
                  }}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {data.exercises.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>

              {exercise.totalVolumeKg > 0 ? (
                <SeriesChart
                  kind="line"
                  title={t('workouts.progression.volume.title', { exercise: exercise.name })}
                  description={t('workouts.progression.volume.description')}
                  data={volumeData}
                  {...(domain === undefined ? {} : { xDomain: domain })}
                  axisLabels={axisLabels}
                  formatValue={formatKg}
                  tableHeaders={[
                    t('workouts.progression.table.date'),
                    t('workouts.progression.table.kg'),
                  ]}
                  keyboardHint={keyboardHint}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('workouts.progression.noWeight')}
                </p>
              )}

              {oneRepMaxData.length > 0 ? (
                <SeriesChart
                  kind="line"
                  title={t('workouts.progression.oneRepMax.title', { exercise: exercise.name })}
                  description={t('workouts.progression.oneRepMax.description')}
                  data={oneRepMaxData}
                  {...(domain === undefined ? {} : { xDomain: domain })}
                  axisLabels={axisLabels}
                  formatValue={formatKg}
                  tableHeaders={[
                    t('workouts.progression.table.date'),
                    t('workouts.progression.table.kg'),
                  ]}
                  keyboardHint={keyboardHint}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('workouts.progression.oneRepMax.empty')}
                </p>
              )}
            </div>
          )}

          <SeriesChart
            kind="bar"
            title={t('workouts.progression.frequency.title')}
            description={t('workouts.progression.frequency.description')}
            data={frequencyData}
            axisLabels={[
              frequencyData[0]?.xLabel ?? '',
              frequencyData[frequencyData.length - 1]?.xLabel ?? '',
            ]}
            formatValue={(value) => numberFormat.format(value)}
            tableHeaders={[
              t('workouts.progression.table.week'),
              t('workouts.progression.table.sessions'),
            ]}
            keyboardHint={keyboardHint}
            integerScale
          />
        </div>
      ) : null}

      <CardioProgressionSection
        windowDays={windowDays}
        {...(tProp === undefined ? {} : { t: tProp })}
        {...(clientProp === undefined ? {} : { client: clientProp })}
      />
    </section>
  );
}
