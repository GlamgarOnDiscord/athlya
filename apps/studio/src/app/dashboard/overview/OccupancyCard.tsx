'use client';

import { LightbulbIcon } from '@phosphor-icons/react';
import { addDays, addWeeks, startOfWeek } from 'date-fns';
import { useMemo, useState, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { BAND_STARTS, buildHeatmap, heatLevel, peakCell } from '../occupancy-heatmap';

import { CARD, CardHeader, CardMessage, RowsSkeleton } from './parts';

import type { Translator } from '../../../lib/i18n/t';
import type { OverviewClass } from '../dashboard-summary';
import type { Locale } from '@athlya/shared/i18n';

const WINDOWS = [4, 12] as const;

interface OccupancyCardProps {
  readonly classes: ReadonlyArray<OverviewClass> | null;
  readonly failed: boolean;
  readonly now: Date | null;
  readonly locale: Locale;
  readonly t: Translator;
}

/** Fill rate by weekday and time band over the last 4 or 12 full weeks. */
export function OccupancyCard({
  classes,
  failed,
  now,
  locale,
  t,
}: OccupancyCardProps): ReactElement {
  const [weeks, setWeeks] = useState<(typeof WINDOWS)[number]>(4);

  const grid = useMemo(() => {
    if (classes === null || now === null) return null;
    const to = startOfWeek(now, { weekStartsOn: 1 });
    return buildHeatmap(classes, addWeeks(to, -weeks), to);
  }, [classes, now, weeks]);
  const peak = grid === null ? null : peakCell(grid);

  // Any Monday works: only the weekday names are read from these dates.
  const monday = new Date(2026, 0, 5);
  const dayNames = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const narrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });

  return (
    <section aria-labelledby="dashboard-occupancy" className={cn(CARD, 'lg:col-span-4')}>
      <CardHeader
        id="dashboard-occupancy"
        title={t('studio.dashboard.occupancy.title')}
        detail={t('studio.dashboard.occupancy.window', { weeks })}
        action={
          <div
            role="group"
            aria-label={t('studio.dashboard.occupancy.windowLabel')}
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={weeks === w}
                onClick={() => setWeeks(w)}
                className={cn(
                  'h-6 rounded px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  weeks === w && 'bg-muted text-foreground',
                )}
              >
                {t('studio.dashboard.occupancy.weeks', { weeks: w })}
              </button>
            ))}
          </div>
        }
      />
      {failed ? (
        <CardMessage text={t('studio.dashboard.loadError')} />
      ) : grid === null ? (
        <RowsSkeleton rows={4} />
      ) : peak === null ? (
        <CardMessage text={t('studio.dashboard.occupancy.empty')} />
      ) : (
        <>
          <div className="px-4 pt-3">
            <table className="w-full table-fixed border-separate border-spacing-1 text-xs">
              <caption className="sr-only">
                {t('studio.dashboard.occupancy.caption', { weeks })}
              </caption>
              <thead>
                <tr>
                  <td />
                  {dayNames.map((d) => (
                    <th
                      key={d.toISOString()}
                      scope="col"
                      abbr={long.format(d)}
                      className="font-normal text-muted-foreground uppercase"
                    >
                      {narrow.format(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, band) => (
                  <tr key={`band-${String(BAND_STARTS[band])}`}>
                    <th
                      scope="row"
                      className="w-9 pr-1 text-left font-normal text-muted-foreground tabular-nums"
                    >
                      {t('studio.dashboard.occupancy.hour', { hour: BAND_STARTS[band] ?? 0 })}
                    </th>
                    {row.map((cell) => {
                      const label =
                        cell.rate === null
                          ? t('studio.dashboard.occupancy.cellEmpty', {
                              day: long.format(dayNames[cell.weekday] ?? monday),
                              hour: BAND_STARTS[band] ?? 0,
                            })
                          : t('studio.dashboard.occupancy.cell', {
                              day: long.format(dayNames[cell.weekday] ?? monday),
                              hour: BAND_STARTS[band] ?? 0,
                              rate: percent.format(cell.rate),
                              classes: cell.classes,
                            });
                      return (
                        <td
                          key={`${String(band)}-${String(cell.weekday)}`}
                          title={label}
                          className="p-0"
                        >
                          <span
                            className={cn(
                              'block h-6 rounded-sm',
                              cell.rate === null
                                ? 'heat-empty'
                                : `heat-${String(heatLevel(cell.rate))}`,
                            )}
                          />
                          <span className="sr-only">{label}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-2 py-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {t('studio.dashboard.occupancy.less')}
                {[0, 1, 2, 3].map((level) => (
                  <span
                    key={level}
                    aria-hidden="true"
                    className={`heat-${String(level)} size-3 rounded-sm`}
                  />
                ))}
                {t('studio.dashboard.occupancy.more')}
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="heat-4 size-3 rounded-sm" />
                {t('studio.dashboard.occupancy.peakLegend')}
              </span>
            </div>
          </div>
          <p className="mt-auto flex items-start gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <LightbulbIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            {t('studio.dashboard.occupancy.insight', {
              day: long.format(dayNames[peak.weekday] ?? monday),
              hour: BAND_STARTS[peak.band] ?? 0,
              rate: percent.format(peak.rate ?? 0),
            })}
          </p>
        </>
      )}
    </section>
  );
}
