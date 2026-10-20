'use client';

import { bookedSeats, type OverviewClass } from '../dashboard-summary';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type { ReactElement } from 'react';

const COLUMNS = ['day', 'time', 'class', 'duration', 'booked', 'left', 'fill'] as const;
const NUMERIC = new Set<string>(['duration', 'booked', 'left', 'fill']);

/** Dense table of the coming classes: tabular numbers, right aligned, sticky header. */
export function UpcomingTable({
  classes,
  locale,
  t,
}: {
  readonly classes: ReadonlyArray<OverviewClass>;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`px-4 py-2 text-[0.6875rem] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase ${
                  NUMERIC.has(col) ? 'text-right' : 'text-left'
                } ${col === 'duration' || col === 'left' ? 'hidden md:table-cell' : ''} ${col === 'booked' || col === 'time' ? 'hidden sm:table-cell' : ''}`}
              >
                {t(`studio.dashboard.upcoming.columns.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {classes.map((cls) => {
            const start = new Date(cls.startsAt);
            const booked = bookedSeats(cls);
            return (
              <tr key={cls.id} className="border-b border-border last:border-b-0 hover:bg-muted/50">
                <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                  {day.format(start)}
                  <span className="text-foreground sm:hidden"> {time.format(start)}</span>
                </td>
                <td className="hidden px-4 py-2 whitespace-nowrap sm:table-cell">
                  <time dateTime={cls.startsAt}>{time.format(start)}</time>
                </td>
                <td className="max-w-48 truncate px-4 py-2 font-medium">{cls.title}</td>
                <td className="hidden px-4 py-2 text-right text-muted-foreground md:table-cell">
                  {t('studio.dashboard.duration.minutes', { m: cls.durationMin })}
                </td>
                <td className="hidden px-4 py-2 text-right whitespace-nowrap sm:table-cell">
                  {booked}/{cls.capacity}
                </td>
                <td className="hidden px-4 py-2 text-right md:table-cell">{cls.remaining}</td>
                <td className="px-4 py-2 text-right">
                  {cls.capacity === 0 ? '0' : percent.format(booked / cls.capacity)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
