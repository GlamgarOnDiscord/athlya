'use client';

import { useCallback, useMemo, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import {
  blockGeometry,
  buildMonthGrid,
  buildWeekDays,
  groupByDay,
  hourBounds,
  layoutDay,
  toDayKey,
  type DayBlock,
  type HourBounds,
  type PlanningView,
} from './planning-grid';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

const MONTH_CELL_LIMIT = 3;
const MONTH_CREATE_HOUR = 9;

export interface ClassesPlanningProps {
  readonly view: PlanningView;
  readonly anchor: Date;
  readonly todayKey: string;
  readonly items: ReadonlyArray<ClassWithRemaining>;
  readonly busy: boolean;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onSelectClass: (cls: ClassWithRemaining) => void;
  readonly onCreateAt: (startsAt: Date) => void;
  readonly onShowDay: (day: Date) => void;
}

interface Formatters {
  readonly time: Intl.DateTimeFormat;
  readonly weekday: Intl.DateTimeFormat;
  readonly dayLong: Intl.DateTimeFormat;
  readonly slot: Intl.DateTimeFormat;
}

function useFormatters(locale: Locale): Formatters {
  return useMemo(
    () => ({
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
      dayLong: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }),
      slot: new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      }),
    }),
    [locale],
  );
}

export function ClassesPlanning(props: ClassesPlanningProps): ReactElement {
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  return (
    <div className="flex flex-col gap-2">
      <div
        aria-busy={props.busy}
        className="overflow-x-auto rounded-lg border border-border bg-background"
      >
        {props.view === 'week' ? <WeekGrid {...props} /> : <MonthGrid {...props} />}
      </div>
      <p className="text-xs text-muted-foreground">
        {props.t('studio.classes.planning.localTime', { timeZone })}
      </p>
    </div>
  );
}

function capacityLabel(cls: ClassWithRemaining, t: Translator): string {
  return cls.remaining <= 0
    ? t('studio.classes.planning.full')
    : t('studio.classes.row.capacity', { remaining: cls.remaining, capacity: cls.capacity });
}

function WeekGrid({
  anchor,
  todayKey,
  items,
  locale,
  t,
  onSelectClass,
  onCreateAt,
}: ClassesPlanningProps): ReactElement {
  const fmt = useFormatters(locale);
  const days = useMemo(() => buildWeekDays(anchor), [anchor]);

  const columns = useMemo(() => {
    const byDay = groupByDay(items);
    return days.map((date) => {
      const key = toDayKey(date);
      return { date, key, blocks: layoutDay(byDay.get(key) ?? []) };
    });
  }, [days, items]);

  const bounds = useMemo(() => hourBounds(columns.flatMap((c) => c.blocks)), [columns]);
  const hours = useMemo(
    () => Array.from({ length: bounds.endHour - bounds.startHour }, (_, i) => bounds.startHour + i),
    [bounds],
  );

  return (
    <div className="grid min-w-[48rem] grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
      <div className="border-b border-border" />
      {columns.map(({ date, key }) => {
        const isToday = key === todayKey;
        return (
          <div
            key={key}
            aria-current={isToday ? 'date' : undefined}
            className="flex flex-col justify-center border-b border-l border-border px-2 py-2"
          >
            <span
              className={cn(
                'text-xs text-muted-foreground',
                isToday && 'font-semibold text-foreground',
              )}
            >
              {fmt.weekday.format(date)}
            </span>
            <span
              className={cn(
                'text-lg font-semibold tabular-nums',
                isToday &&
                  'inline-grid size-7 place-items-center rounded-md bg-foreground text-base text-background',
              )}
            >
              {date.getDate()}
            </span>
          </div>
        );
      })}

      <div aria-hidden="true">
        {hours.map((hour) => (
          <div
            key={hour}
            className="h-12 pr-2 text-right text-[0.7rem] text-muted-foreground tabular-nums"
          >
            {hour === bounds.startHour ? null : (
              <span className="relative -top-2">{`${String(hour).padStart(2, '0')}:00`}</span>
            )}
          </div>
        ))}
      </div>

      {columns.map(({ date, key, blocks }) => {
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        return (
          <div
            key={key}
            data-day={key}
            className={cn('relative border-l border-border', weekend && 'bg-muted/40')}
          >
            {blocks.map((block) => (
              <WeekBlock
                key={block.item.id}
                block={block}
                bounds={bounds}
                fmt={fmt}
                t={t}
                onSelect={onSelectClass}
              />
            ))}
            {hours.map((hour) => {
              const start = new Date(date);
              start.setHours(hour, 0, 0, 0);
              return (
                <button
                  key={hour}
                  type="button"
                  aria-label={t('studio.classes.planning.createAt', {
                    date: fmt.slot.format(start),
                  })}
                  onClick={() => onCreateAt(start)}
                  className="block h-12 w-full border-t border-border first:border-t-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

interface WeekBlockProps {
  readonly block: DayBlock<ClassWithRemaining>;
  readonly bounds: HourBounds;
  readonly fmt: Formatters;
  readonly t: Translator;
  readonly onSelect: (cls: ClassWithRemaining) => void;
}

function WeekBlock({ block, bounds, fmt, t, onSelect }: WeekBlockProps): ReactElement {
  const cls = block.item;
  const geometry = blockGeometry(block, bounds);
  const start = new Date(cls.startsAt);
  const end = new Date(start.getTime() + cls.durationMin * 60_000);
  const full = cls.remaining <= 0;

  const placeBlock = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node === null) return;
      node.style.setProperty('--block-top', `${geometry.top}%`);
      node.style.setProperty('--block-height', `${geometry.height}%`);
      node.style.setProperty('--block-left', `${geometry.left}%`);
      node.style.setProperty('--block-width', `${geometry.width}%`);
    },
    [geometry.top, geometry.height, geometry.left, geometry.width],
  );

  return (
    <button
      ref={placeBlock}
      type="button"
      data-class-id={cls.id}
      onClick={() => onSelect(cls)}
      className="planning-block absolute z-10 flex flex-col items-start overflow-hidden rounded-md border border-l-4 border-border border-l-primary bg-background px-1.5 py-0.5 text-left text-xs hover:bg-muted focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-full truncate font-semibold text-foreground">{cls.title}</span>
      <span className="w-full truncate text-muted-foreground tabular-nums">
        <span className="sr-only">{fmt.dayLong.format(start)}, </span>
        {fmt.time.format(start)} - {fmt.time.format(end)}
      </span>
      <span className={cn('w-full truncate', full ? 'text-destructive' : 'text-muted-foreground')}>
        {capacityLabel(cls, t)}
      </span>
    </button>
  );
}

function MonthGrid({
  anchor,
  todayKey,
  items,
  locale,
  t,
  onSelectClass,
  onCreateAt,
  onShowDay,
}: ClassesPlanningProps): ReactElement {
  const fmt = useFormatters(locale);
  const weeks = useMemo(() => buildMonthGrid(anchor), [anchor]);
  const byDay = useMemo(() => groupByDay(items), [items]);

  return (
    <div className="min-w-[48rem]">
      <div className="grid grid-cols-7 border-b border-border">
        {weeks[0]?.map(({ key, date }) => (
          <div
            key={key}
            className="border-l border-border px-2 py-2 text-xs text-muted-foreground first:border-l-0"
          >
            {fmt.weekday.format(date)}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]?.key} className="grid grid-cols-7 border-b border-border last:border-b-0">
          {week.map(({ date, key, inMonth }) => {
            const dayItems = byDay.get(key) ?? [];
            const shown = dayItems.slice(0, MONTH_CELL_LIMIT);
            const hidden = dayItems.length - shown.length;
            const isToday = key === todayKey;
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            const createStart = new Date(date);
            createStart.setHours(MONTH_CREATE_HOUR, 0, 0, 0);
            return (
              <div
                key={key}
                data-day={key}
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'relative flex min-h-28 flex-col gap-1 border-l border-border p-1.5 pt-9 first:border-l-0',
                  weekend && 'bg-muted/40',
                )}
              >
                <button
                  type="button"
                  aria-label={t('studio.classes.planning.createAt', {
                    date: fmt.dayLong.format(date),
                  })}
                  onClick={() => onCreateAt(createStart)}
                  className="absolute inset-0 flex items-start p-1.5 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span
                    className={cn(
                      'inline-grid size-7 place-items-center rounded-md text-sm tabular-nums',
                      inMonth ? 'text-foreground' : 'text-muted-foreground',
                      isToday && 'bg-foreground font-semibold text-background',
                    )}
                  >
                    {date.getDate()}
                  </span>
                </button>
                {shown.map((cls) => (
                  <button
                    key={cls.id}
                    type="button"
                    data-class-id={cls.id}
                    onClick={() => onSelectClass(cls)}
                    className="relative z-10 flex w-full items-center gap-1.5 truncate rounded-md border border-l-4 border-border border-l-primary bg-background px-1.5 py-0.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      <span className="sr-only">{fmt.dayLong.format(date)}, </span>
                      {fmt.time.format(new Date(cls.startsAt))}
                    </span>
                    <span className="truncate font-medium text-foreground">{cls.title}</span>
                    {cls.remaining <= 0 ? (
                      <span className="ml-auto text-destructive">
                        {t('studio.classes.planning.full')}
                      </span>
                    ) : null}
                  </button>
                ))}
                {hidden > 0 ? (
                  <button
                    type="button"
                    onClick={() => onShowDay(date)}
                    className="relative z-10 self-start rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('studio.classes.planning.more', { count: hidden })}
                    <span className="sr-only">, {fmt.dayLong.format(date)}</span>
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
