'use client';

import { addDays } from 'date-fns';

import { cn } from '@/lib/utils';

import { MarkBar } from './parts';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type { ReactElement } from 'react';

interface BookingsChartProps {
  readonly values: ReadonlyArray<number>;
  readonly weekStart: Date;
  /** Index of today in the week, the one bar drawn in the accent. */
  readonly todayIndex: number;
  readonly locale: Locale;
  readonly t: Translator;
}

/** Seats booked per day of the current week; every value is printed above its bar. */
export function BookingsChart({
  values,
  weekStart,
  todayIndex,
  locale,
  t,
}: BookingsChartProps): ReactElement {
  const max = Math.max(1, ...values);
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const full = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  return (
    <ol className="grid h-48 grid-cols-7 items-end gap-2 px-4 pt-4 pb-3">
      {values.map((value, index) => {
        const date = addDays(weekStart, index);
        return (
          <li
            key={date.toISOString()}
            className="flex h-full flex-col items-center gap-1.5"
            aria-label={t('studio.dashboard.bookings.dayLabel', {
              day: full.format(date),
              count: value,
            })}
          >
            <span
              aria-hidden="true"
              className={cn(
                'text-xs tabular-nums',
                index === todayIndex ? 'font-semibold' : 'text-muted-foreground',
              )}
            >
              {value}
            </span>
            <span aria-hidden="true" className="flex w-full flex-1 items-end">
              <MarkBar ratio={value / max} accent={index === todayIndex} className="rounded-md" />
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'text-xs capitalize',
                index === todayIndex ? 'font-semibold' : 'text-muted-foreground',
              )}
            >
              {day.format(date).replace('.', '')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
