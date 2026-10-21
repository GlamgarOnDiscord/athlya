'use client';

import Link from 'next/link';
import { Fragment, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { classRosterHref } from '../../../lib/links';
import { bookedSeats, classTiming, minutesUntil, type OverviewClass } from '../dashboard-summary';
import { formatDuration } from '../format-duration';

import { FillMeter } from './parts';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

interface TodayTimelineProps {
  readonly classes: ReadonlyArray<OverviewClass>;
  readonly next: OverviewClass | null;
  readonly now: Date;
  readonly locale: Locale;
  readonly t: Translator;
}

/**
 * Today's classes on a time rail: start and end, the class, its fill and
 * its state. A now-line sits between the classes that started and the
 * ones still to come. Each title opens the class roster: the admin
 * overview lists the studio's classes, the coach home only the coach's.
 */
export function TodayTimeline({ classes, next, now, locale, t }: TodayTimelineProps): ReactElement {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const nowIndex = classes.findIndex((c) => new Date(c.startsAt) > now);
  const lineAt = nowIndex === -1 ? classes.length : nowIndex;

  return (
    <div role="table" aria-label={t('studio.dashboard.today.title')} className="text-sm">
      <div role="rowgroup">
        <div
          role="row"
          className="grid grid-cols-[7.5rem_1fr_auto] gap-4 border-b border-border px-4 py-2 sm:grid-cols-[7rem_1fr_12rem_7rem]"
        >
          {(['time', 'class', 'booked', 'status'] as const).map((col) => (
            <span
              key={col}
              role="columnheader"
              className={cn(
                'text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase',
                col === 'status' && 'text-right',
                col === 'booked' && 'hidden sm:block',
              )}
            >
              {t(`studio.dashboard.today.columns.${col}`)}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {classes.map((cls, index) => {
          const start = new Date(cls.startsAt);
          const end = new Date(start.getTime() + cls.durationMin * 60_000);
          const timing = classTiming(cls, now);
          const isNext = next?.id === cls.id;
          const booked = bookedSeats(cls);
          return (
            <Fragment key={cls.id}>
              {index === lineAt ? <NowLine now={now} time={time} t={t} /> : null}
              <div
                role="row"
                className={cn(
                  'grid grid-cols-[7.5rem_1fr_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[7rem_1fr_12rem_7rem]',
                  timing === 'done' && 'text-muted-foreground',
                  isNext && 'bg-muted/50',
                )}
              >
                <span role="cell" className="border-l-2 border-border pl-3 tabular-nums">
                  <time dateTime={cls.startsAt} className="font-medium">
                    {time.format(start)}
                  </time>
                  <span className="text-muted-foreground">
                    {' - '}
                    <time dateTime={end.toISOString()}>{time.format(end)}</time>
                  </span>
                </span>
                <span role="cell" className="truncate">
                  <Link
                    href={classRosterHref(cls.id)}
                    className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {cls.title}
                  </Link>
                </span>
                <span role="cell" className="hidden sm:block">
                  <FillMeter
                    booked={booked}
                    capacity={cls.capacity}
                    label={t('studio.dashboard.today.fillLabel', {
                      booked,
                      capacity: cls.capacity,
                    })}
                  />
                </span>
                <span role="cell" className="text-right">
                  <StatusChip
                    timing={timing}
                    isNext={isNext}
                    minutes={minutesUntil(cls.startsAt, now)}
                    t={t}
                  />
                </span>
              </div>
            </Fragment>
          );
        })}
        {lineAt === classes.length ? <NowLine now={now} time={time} t={t} /> : null}
      </div>
    </div>
  );
}

function NowLine({
  now,
  time,
  t,
}: {
  readonly now: Date;
  readonly time: Intl.DateTimeFormat;
  readonly t: Translator;
}): ReactElement {
  return (
    <div role="row" className="relative flex h-0 items-center px-4" data-testid="dashboard-now">
      <span role="cell" className="relative z-10 flex w-full items-center gap-2">
        <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-background tabular-nums">
          {t('studio.dashboard.today.now', { time: time.format(now) })}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-foreground" />
      </span>
    </div>
  );
}

function StatusChip({
  timing,
  isNext,
  minutes,
  t,
}: {
  readonly timing: ReturnType<typeof classTiming>;
  readonly isNext: boolean;
  readonly minutes: number;
  readonly t: Translator;
}): ReactElement {
  const base =
    'inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap';
  if (timing === 'done') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')}>
        {t('studio.dashboard.today.done')}
      </span>
    );
  }
  if (timing === 'live') {
    return (
      <span className={cn(base, 'planning-pill-open')}>{t('studio.dashboard.today.live')}</span>
    );
  }
  return (
    <span className={cn(base, isNext ? 'planning-pill-open' : 'border border-border')}>
      {t('studio.dashboard.today.inTime', { time: formatDuration(minutes, t) })}
    </span>
  );
}
