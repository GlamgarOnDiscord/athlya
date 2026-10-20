'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { bookedSeats, type OverviewClass } from '../dashboard-summary';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type { ReactElement } from 'react';

const COLUMNS = ['day', 'time', 'class', 'duration', 'booked', 'left', 'fill'] as const;
const NUMERIC = new Set<string>(['duration', 'booked', 'left', 'fill']);

/**
 * Dense table of the coming classes: tabular numbers, right aligned, sticky
 * header. On a wide screen the card takes its neighbour's height and the
 * rows scroll inside it; while rows remain below, the last one fades out so
 * a row cut by the edge reads as "more below", not as a broken layout.
 * The scroll box takes focus so keyboard users can scroll it.
 */
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, classes]);
  return (
    <div
      ref={scrollRef}
      onScroll={measure}
      data-more={more}
      tabIndex={0}
      className="scroll-fade-bottom max-h-80 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:h-0 lg:max-h-none lg:min-h-48 lg:flex-1"
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {COLUMNS.map((col) => (
              <th
                key={col}
                scope="col"
                className={`px-2 py-2 text-[0.6875rem] sm:px-4 font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase ${
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
                <td className="px-2 py-2 sm:px-4 whitespace-nowrap text-muted-foreground">
                  {day.format(start)}
                  <span className="text-foreground sm:hidden"> {time.format(start)}</span>
                </td>
                <td className="hidden px-2 py-2 sm:px-4 whitespace-nowrap sm:table-cell">
                  <time dateTime={cls.startsAt}>{time.format(start)}</time>
                </td>
                <td className="max-w-48 truncate px-2 py-2 font-medium sm:px-4">{cls.title}</td>
                <td className="hidden px-2 py-2 sm:px-4 text-right text-muted-foreground md:table-cell">
                  {t('studio.dashboard.duration.minutes', { m: cls.durationMin })}
                </td>
                <td className="hidden px-2 py-2 sm:px-4 text-right whitespace-nowrap sm:table-cell">
                  {booked}/{cls.capacity}
                </td>
                <td className="hidden px-2 py-2 sm:px-4 text-right md:table-cell">
                  {cls.remaining}
                </td>
                <td className="px-2 py-2 sm:px-4 text-right">
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
