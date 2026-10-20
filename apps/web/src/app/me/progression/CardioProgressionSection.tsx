/**
 * `<CardioProgressionSection />` — cardio progression graphs (issue #683, web).
 *
 * Fetches `GET /v1/me/progression/cardio?window=30|90|365&bucket=day|week`
 * for the window picked in `<ProgressionPanel />` and renders, for the
 * selected machine, three accessible SVG charts (see `<SeriesChart />`):
 *   - a bar chart of the distance per day or per ISO week,
 *   - a line chart of the average power of each session,
 *   - a line chart of the average speed of each session.
 *
 * The endpoint is newer than `/v1/me/progression`: a 404 from a Worker
 * that predates it shows the section as unavailable, not as an error.
 * The body is validated with `CardioProgressionResponseSchema`.
 *
 * Layering mirrors `<ProgressionPanel />`: optional `client` and `t`
 * props are test seams; production derives both from context.
 */
'use client';

import {
  CardioProgressionResponseSchema,
  type CardioProgressionBucket,
  type CardioProgressionMachine,
  type CardioProgressionResponse,
  type CardioSessionPoint,
} from '@athlya/shared/schemas/api';
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

import { dayMs } from '../../../components/charts/chart-utils';
import { SeriesChart, type SeriesDatum } from '../../../components/charts/SeriesChart';
import { ApiError, type ApiClient } from '../../../lib/api/client';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

export type CardioWindow = '30' | '90' | '365';

export interface CardioProgressionSectionProps {
  readonly windowDays: CardioWindow;
  readonly t?: Translator;
  readonly client?: ApiClient;
}

const BUCKETS: readonly CardioProgressionBucket[] = ['week', 'day'];

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

export function cardioProgressionPath(
  windowDays: CardioWindow,
  bucket: CardioProgressionBucket,
): string {
  return `/v1/me/progression/cardio?window=${windowDays}&bucket=${bucket}`;
}

type Result =
  | { readonly kind: 'error' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly data: CardioProgressionResponse };

export function CardioProgressionSection({
  windowDays,
  t: tProp,
  client: clientProp,
}: CardioProgressionSectionProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);
  const client = useApiClient(clientProp);
  const id = useId();
  const headingId = `${id}-heading`;
  const machineSelectId = `${id}-machine`;

  const [bucket, setBucket] = useState<CardioProgressionBucket>('week');
  const [machineKey, setMachineKey] = useState<CardioProgressionMachine | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const path = cardioProgressionPath(windowDays, bucket);
  const requestKey = `${path}#${String(reloadNonce)}`;
  const [result, setResult] = useState<{ readonly key: string; readonly value: Result } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    client
      .get<unknown>(path)
      .then((raw) => {
        const parsed = CardioProgressionResponseSchema.safeParse(raw);
        const value: Result = parsed.success
          ? { kind: 'ready', data: parsed.data }
          : { kind: 'error' };
        if (!cancelled) setResult({ key: requestKey, value });
      })
      .catch((error: unknown) => {
        const value: Result =
          error instanceof ApiError && error.status === 404
            ? { kind: 'unavailable' }
            : { kind: 'error' };
        if (!cancelled) setResult({ key: requestKey, value });
      });
    return () => {
      cancelled = true;
    };
  }, [client, path, requestKey]);

  const status = result?.key === requestKey ? result.value : null;

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [locale],
  );
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const formatNumber = (value: number): string => numberFormat.format(value);
  const formatDay = (date: string): string => dateFormat.format(dayMs(date));
  const formatInstant = (iso: string): string => dateFormat.format(Date.parse(iso));
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0
      ? t('workouts.progression.cardio.units.hoursMinutes', { hours, minutes })
      : t('workouts.progression.cardio.units.minutes', { minutes });
  };

  const data = status?.kind === 'ready' ? status.data : null;
  const machine =
    data === null
      ? undefined
      : (data.machines.find((m) => m.machine === machineKey) ?? data.machines[0]);
  const machineName =
    machine === undefined ? '' : t(`workouts.progression.cardio.machines.${machine.machine}`);

  const domain: readonly [number, number] | undefined =
    data === null ? undefined : [Date.parse(data.from), Date.parse(data.to)];
  const axisLabels: readonly [string, string] =
    data === null
      ? ['', '']
      : [
          dateFormat.format(Date.parse(data.from)),
          dateFormat.format(Date.parse(data.to) - HALF_DAY_MS),
        ];

  const byWeek = (data?.bucket ?? bucket) === 'week';
  const distanceData: SeriesDatum[] =
    machine?.series.map((b) => ({
      key: b.periodStart,
      x: dayMs(b.periodStart),
      value: b.distanceM / 1000,
      xLabel: formatDay(b.periodStart),
      label: t(
        byWeek
          ? 'workouts.progression.cardio.distance.pointWeek'
          : 'workouts.progression.cardio.distance.pointDay',
        { date: formatDay(b.periodStart), value: formatNumber(b.distanceM / 1000) },
      ),
    })) ?? [];
  const hasDistance = machine !== undefined && machine.totals.distanceM > 0;

  const trend = (
    pick: (point: CardioSessionPoint) => number | null,
    pointKey: 'workouts.progression.cardio.power.point' | 'workouts.progression.cardio.speed.point',
  ): SeriesDatum[] =>
    machine?.points.flatMap((p, i) => {
      const value = pick(p);
      return value === null
        ? []
        : [
            {
              key: `${p.startedAt}-${String(i)}`,
              x: Date.parse(p.startedAt),
              value,
              xLabel: formatInstant(p.startedAt),
              label: t(pointKey, {
                date: formatInstant(p.startedAt),
                value: formatNumber(value),
              }),
            },
          ];
    }) ?? [];
  const powerData = trend((p) => p.avgPowerW, 'workouts.progression.cardio.power.point');
  const speedData = trend((p) => p.avgSpeedKmh, 'workouts.progression.cardio.speed.point');

  const keyboardHint = t('workouts.progression.keyboardHint');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="text-2xl font-semibold">
          {t('workouts.progression.cardio.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('workouts.progression.cardio.description')}
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          {t('workouts.progression.cardio.bucket.legend')}
        </legend>
        <div className="flex flex-wrap gap-2">
          {BUCKETS.map((value) => (
            <label
              key={value}
              className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="progression-cardio-bucket"
                value={value}
                checked={bucket === value}
                onChange={() => {
                  setBucket(value);
                }}
                className="sr-only"
              />
              {t(`workouts.progression.cardio.bucket.${value}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {status === null ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('common.loading')}
        </p>
      ) : null}

      {status?.kind === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">
          {t('workouts.progression.cardio.unavailable')}
        </p>
      ) : null}

      {status?.kind === 'error' ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-sm text-destructive">{t('errors.generic')}</p>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              setReloadNonce((n) => n + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {data !== null && machine === undefined ? (
        <p className="text-sm text-muted-foreground">{t('workouts.progression.cardio.empty')}</p>
      ) : null}

      {data !== null && machine !== undefined ? (
        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-2">
            <Label htmlFor={machineSelectId}>{t('workouts.progression.cardio.machine')}</Label>
            <select
              id={machineSelectId}
              value={machine.machine}
              onChange={(event) => {
                const next = data.machines.find((m) => m.machine === event.target.value);
                if (next !== undefined) setMachineKey(next.machine);
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {data.machines.map((m) => (
                <option key={m.machine} value={m.machine}>
                  {t(`workouts.progression.cardio.machines.${m.machine}`)}
                </option>
              ))}
            </select>
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.cardio.summary.sessions')}
              </dt>
              <dd className="text-2xl font-semibold">{formatNumber(machine.sessionCount)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.cardio.summary.distance')}
              </dt>
              <dd className="text-2xl font-semibold">
                {t('workouts.progression.cardio.units.km', {
                  value: formatNumber(machine.totals.distanceM / 1000),
                })}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.cardio.summary.duration')}
              </dt>
              <dd className="text-2xl font-semibold">
                {formatDuration(machine.totals.durationSec)}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-muted-foreground">
                {t('workouts.progression.cardio.summary.energy')}
              </dt>
              <dd className="text-2xl font-semibold">
                {t('workouts.progression.cardio.units.kcal', {
                  value: formatNumber(machine.totals.energyKcal),
                })}
              </dd>
            </div>
          </dl>

          {data.truncated ? (
            <p className="text-sm text-muted-foreground">{t('workouts.progression.truncated')}</p>
          ) : null}

          {hasDistance ? (
            <SeriesChart
              kind="bar"
              title={t(
                byWeek
                  ? 'workouts.progression.cardio.distance.titleWeek'
                  : 'workouts.progression.cardio.distance.titleDay',
                { machine: machineName },
              )}
              description={t('workouts.progression.cardio.distance.description')}
              data={distanceData}
              axisLabels={[
                distanceData[0]?.xLabel ?? '',
                distanceData[distanceData.length - 1]?.xLabel ?? '',
              ]}
              formatValue={formatNumber}
              tableHeaders={[
                t(byWeek ? 'workouts.progression.table.week' : 'workouts.progression.table.date'),
                t('workouts.progression.cardio.table.km'),
              ]}
              keyboardHint={keyboardHint}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('workouts.progression.cardio.distance.empty')}
            </p>
          )}

          {powerData.length > 0 ? (
            <SeriesChart
              kind="line"
              title={t('workouts.progression.cardio.power.title', { machine: machineName })}
              description={t('workouts.progression.cardio.power.description')}
              data={powerData}
              {...(domain === undefined ? {} : { xDomain: domain })}
              axisLabels={axisLabels}
              formatValue={formatNumber}
              tableHeaders={[
                t('workouts.progression.table.date'),
                t('workouts.progression.cardio.table.watts'),
              ]}
              keyboardHint={keyboardHint}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('workouts.progression.cardio.power.empty')}
            </p>
          )}

          {speedData.length > 0 ? (
            <SeriesChart
              kind="line"
              title={t('workouts.progression.cardio.speed.title', { machine: machineName })}
              description={t('workouts.progression.cardio.speed.description')}
              data={speedData}
              {...(domain === undefined ? {} : { xDomain: domain })}
              axisLabels={axisLabels}
              formatValue={formatNumber}
              tableHeaders={[
                t('workouts.progression.table.date'),
                t('workouts.progression.cardio.table.kmh'),
              ]}
              keyboardHint={keyboardHint}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('workouts.progression.cardio.speed.empty')}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
