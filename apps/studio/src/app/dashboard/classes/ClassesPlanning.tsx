'use client';

import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon, ProhibitIcon, UsersIcon } from '@phosphor-icons/react';
import { useCallback, useMemo, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { useNowMinute } from '../../../lib/use-now-minute';

import {
  blockDensity,
  blockGeometry,
  buildMonthGrid,
  buildWeekDays,
  groupByDay,
  hourBounds,
  layoutDay,
  seatsLeftKey,
  toDayKey,
  type DayBlock,
  type HourBounds,
  type PlanningView,
} from './planning-grid';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';
import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

const MONTH_CELL_LIMIT = 3;
const DEFAULT_CREATE_HOUR = 9;

export interface ClassesPlanningProps {
  readonly view: PlanningView;
  readonly anchor: Date;
  readonly todayKey: string;
  readonly items: ReadonlyArray<ClassWithRemaining>;
  readonly busy: boolean;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onSelectClass: (cls: ClassWithRemaining) => void;
  readonly onDeleteClass: (cls: ClassWithRemaining) => void;
  readonly onCreateAt: (startsAt: Date) => void;
  readonly onShowDay: (day: Date) => void;
}

interface Formatters {
  readonly time: Intl.DateTimeFormat;
  readonly weekday: Intl.DateTimeFormat;
  readonly dayLong: Intl.DateTimeFormat;
  readonly slot: Intl.DateTimeFormat;
  readonly locale: Locale;
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
      locale,
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
        className="overflow-x-auto rounded-xl border border-border bg-background"
      >
        {props.view === 'week' ? (
          <WeekGrid {...props} />
        ) : props.view === 'month' ? (
          <MonthGrid {...props} />
        ) : (
          <DayAgenda {...props} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {props.t('studio.classes.planning.localTime', { timeZone })}
      </p>
    </div>
  );
}

function isFull(cls: ClassWithRemaining): boolean {
  return cls.remaining <= 0;
}

/**
 * Tile surface: open classes sit on the muted surface with ink text, full
 * ones on the plain background with quieter text, so the state reads from
 * the pill and the tone, not from colour alone.
 */
function tileClass(cls: ClassWithRemaining): string {
  return isFull(cls)
    ? 'border-border bg-background text-muted-foreground'
    : 'border-border bg-muted text-foreground hover:border-muted-foreground/40';
}

/** "Mon 19" without the abbreviation dot some locales add. */
function shortWeekday(fmt: Formatters, date: Date): string {
  return fmt.weekday.format(date).replace(/\.$/u, '');
}

/**
 * Status pill: "Full", or the seats still open. The compact size fits a
 * 16px text line, for week tiles too short for the full pill.
 */
function StatusPill({
  cls,
  fmt,
  t,
  compact = false,
}: {
  readonly cls: ClassWithRemaining;
  readonly fmt: Formatters;
  readonly t: Translator;
  readonly compact?: boolean;
}): ReactElement {
  const full = isFull(cls);
  const Icon = full ? ProhibitIcon : UsersIcon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full text-[0.6875rem] leading-none font-medium tabular-nums',
        compact ? 'h-4 px-1.5' : 'h-5 px-2',
        full ? 'planning-pill-full' : 'planning-pill-open',
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {full
        ? t('studio.classes.planning.full')
        : t(seatsLeftKey(fmt.locale, cls.remaining), { count: cls.remaining })}
    </span>
  );
}

/**
 * Edit / delete menu behind a "..." button. The compact trigger sits
 * tighter in the corner so it fits the title line of a 45-minute tile,
 * and keeps the 24 px minimum pointer target either way.
 */
function TileMenu({
  cls,
  t,
  onEdit,
  onDelete,
  compact = false,
}: {
  readonly cls: ClassWithRemaining;
  readonly t: Translator;
  readonly onEdit: (cls: ClassWithRemaining) => void;
  readonly onDelete: (cls: ClassWithRemaining) => void;
  readonly compact?: boolean;
}): ReactElement {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={t('studio.classes.planning.actionsFor', { title: cls.title })}
        className={cn(
          'absolute z-10 grid place-items-center rounded-md hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/10',
          compact ? 'top-0.5 right-0.5 size-6' : 'top-1.5 right-1.5 size-6',
        )}
      >
        <DotsThreeIcon aria-hidden="true" weight="bold" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-36 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-sm outline-none">
            <Menu.Item
              onClick={() => onEdit(cls)}
              className="flex h-8 cursor-default items-center rounded-md px-2 outline-none data-highlighted:bg-muted"
            >
              {t('studio.classes.row.edit')}
            </Menu.Item>
            <Menu.Item
              onClick={() => onDelete(cls)}
              className="flex h-8 cursor-default items-center rounded-md px-2 text-destructive outline-none data-highlighted:bg-muted"
            >
              {t('studio.classes.row.delete')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function WeekGrid({
  anchor,
  todayKey,
  items,
  locale,
  t,
  onSelectClass,
  onDeleteClass,
  onCreateAt,
}: ClassesPlanningProps): ReactElement {
  const fmt = useFormatters(locale);
  const days = useMemo(() => buildWeekDays(anchor), [anchor]);
  const nowMinute = useNowMinute();
  const now = nowMinute === null ? null : new Date(nowMinute * 60_000);
  const nowKey = now === null ? null : toDayKey(now);

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
            className={cn(
              'flex h-10 items-center justify-center gap-1 border-b border-l border-border text-sm',
              isToday ? 'planning-today font-medium' : 'text-muted-foreground',
            )}
          >
            <span className="first-letter:uppercase">{shortWeekday(fmt, date)}</span>
            <span className="tabular-nums">{date.getDate()}</span>
          </div>
        );
      })}

      <div aria-hidden="true">
        {hours.map((hour) => (
          <div
            key={hour}
            className="h-20 pr-2 text-right text-[0.7rem] text-muted-foreground tabular-nums"
          >
            {hour === bounds.startHour ? null : (
              <span className="relative -top-2">{`${String(hour).padStart(2, '0')}:00`}</span>
            )}
          </div>
        ))}
      </div>

      {columns.map(({ date, key, blocks }) => (
        <div
          key={key}
          data-day={key}
          className={cn('relative border-l border-border', key === todayKey && 'bg-muted/30')}
        >
          {blocks.map((block) => (
            <WeekBlock
              key={block.item.id}
              block={block}
              bounds={bounds}
              fmt={fmt}
              t={t}
              onSelect={onSelectClass}
              onDelete={onDeleteClass}
            />
          ))}
          {now !== null && key === nowKey ? <NowLine now={now} bounds={bounds} fmt={fmt} /> : null}
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
                className="block h-20 w-full border-t border-border first:border-t-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function NowLine({
  now,
  bounds,
  fmt,
}: {
  readonly now: Date;
  readonly bounds: HourBounds;
  readonly fmt: Formatters;
}): ReactElement | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const top =
    ((minutes - bounds.startHour * 60) / ((bounds.endHour - bounds.startHour) * 60)) * 100;
  const place = useCallback(
    (node: HTMLDivElement | null) => {
      node?.style.setProperty('--now-top', `${top}%`);
    },
    [top],
  );
  if (top < 0 || top > 100) return null;
  return (
    <div
      ref={place}
      aria-hidden="true"
      data-testid="planning-now"
      className="planning-now planning-now-line pointer-events-none absolute inset-x-0 z-30 h-px"
    >
      <span className="planning-now-pill absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium tabular-nums">
        {fmt.time.format(now)}
      </span>
    </div>
  );
}

interface WeekBlockProps {
  readonly block: DayBlock<ClassWithRemaining>;
  readonly bounds: HourBounds;
  readonly fmt: Formatters;
  readonly t: Translator;
  readonly onSelect: (cls: ClassWithRemaining) => void;
  readonly onDelete: (cls: ClassWithRemaining) => void;
}

function WeekBlock({ block, bounds, fmt, t, onSelect, onDelete }: WeekBlockProps): ReactElement {
  const cls = block.item;
  const geometry = blockGeometry(block, bounds);
  const start = new Date(cls.startsAt);
  const end = new Date(start.getTime() + cls.durationMin * 60_000);
  const density = blockDensity(block);

  const placeBlock = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) return;
      node.style.setProperty('--block-top', `${geometry.top}%`);
      node.style.setProperty('--block-height', `${geometry.height}%`);
      node.style.setProperty('--block-left', `${geometry.left}%`);
      node.style.setProperty('--block-width', `${geometry.width}%`);
    },
    [geometry.top, geometry.height, geometry.left, geometry.width],
  );

  return (
    <div
      ref={placeBlock}
      data-density={density}
      data-full={isFull(cls)}
      className={cn(
        'planning-block absolute z-10 rounded-xl border focus-within:z-20',
        tileClass(cls),
      )}
    >
      <button
        type="button"
        data-class-id={cls.id}
        onClick={() => onSelect(cls)}
        className={cn(
          'flex size-full flex-col items-start overflow-hidden rounded-[inherit] px-2.5 text-left text-xs leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          density === 'full' && 'py-2',
          density === 'medium' && 'py-0.5',
          density === 'compact' && 'justify-center',
        )}
      >
        <span className="sr-only">{fmt.dayLong.format(start)}, </span>
        <span className={cn('w-full truncate font-medium', density !== 'compact' && 'pr-6')}>
          {cls.title}
        </span>
        {density === 'compact' ? (
          <span className="sr-only">
            , {fmt.time.format(start)} - {fmt.time.format(end)}
          </span>
        ) : (
          <span className="w-full truncate text-muted-foreground tabular-nums">
            {fmt.time.format(start)} - {fmt.time.format(end)}
          </span>
        )}
        {density === 'compact' ? (
          <span className="sr-only">
            ,{' '}
            {isFull(cls)
              ? t('studio.classes.planning.full')
              : t(seatsLeftKey(fmt.locale, cls.remaining), { count: cls.remaining })}
          </span>
        ) : (
          <span className="mt-auto">
            <StatusPill cls={cls} fmt={fmt} t={t} compact={density === 'medium'} />
          </span>
        )}
      </button>
      {density === 'compact' ? null : (
        <TileMenu
          cls={cls}
          t={t}
          onEdit={onSelect}
          onDelete={onDelete}
          compact={density === 'medium'}
        />
      )}
    </div>
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
            className="border-l border-border px-2.5 py-2 text-xs text-muted-foreground first:border-l-0"
          >
            <span className="first-letter:uppercase">{shortWeekday(fmt, date)}</span>
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
            const createStart = new Date(date);
            createStart.setHours(DEFAULT_CREATE_HOUR, 0, 0, 0);
            return (
              <div
                key={key}
                data-day={key}
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'relative flex min-h-28 flex-col gap-1 border-l border-border px-1.5 pt-9 pb-1.5 first:border-l-0',
                  isToday && 'bg-muted/30',
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
                      'inline-grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-sm tabular-nums',
                      inMonth ? 'text-foreground' : 'text-muted-foreground',
                      isToday && 'planning-today font-semibold',
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
                    data-full={isFull(cls)}
                    onClick={() => onSelectClass(cls)}
                    className={cn(
                      'relative z-10 flex h-6 w-full min-w-0 items-center gap-1.5 rounded-lg border px-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      tileClass(cls),
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      <span className="sr-only">{fmt.dayLong.format(date)}, </span>
                      {fmt.time.format(new Date(cls.startsAt))}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{cls.title}</span>
                    {isFull(cls) ? (
                      <span className="flex shrink-0 items-center">
                        <ProhibitIcon aria-hidden="true" className="size-3" />
                        <span className="sr-only">, {t('studio.classes.planning.full')}</span>
                      </span>
                    ) : null}
                  </button>
                ))}
                {hidden > 0 ? (
                  <button
                    type="button"
                    onClick={() => onShowDay(date)}
                    className="relative z-10 self-start rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function DayAgenda({
  anchor,
  todayKey,
  items,
  locale,
  t,
  onSelectClass,
  onDeleteClass,
  onCreateAt,
  onShowDay,
}: ClassesPlanningProps): ReactElement {
  const fmt = useFormatters(locale);
  const days = useMemo(() => buildWeekDays(anchor), [anchor]);
  const anchorKey = toDayKey(anchor);
  const dayItems = useMemo(() => groupByDay(items).get(anchorKey) ?? [], [items, anchorKey]);
  const createStart = new Date(anchor);
  createStart.setHours(DEFAULT_CREATE_HOUR, 0, 0, 0);

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-7 gap-1 border-b border-border p-1.5">
        {days.map((date) => {
          const key = toDayKey(date);
          const selected = key === anchorKey;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              aria-current={key === todayKey ? 'date' : undefined}
              onClick={() => onShowDay(date)}
              className={cn(
                'flex flex-col items-center rounded-xl py-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'planning-today',
                !selected && key === todayKey && 'font-semibold text-foreground',
              )}
            >
              <span aria-hidden="true" className="text-[0.7rem] first-letter:uppercase">
                {shortWeekday(fmt, date)}
              </span>
              <span aria-hidden="true" className="text-base font-semibold tabular-nums">
                {date.getDate()}
              </span>
              <span className="sr-only">{fmt.dayLong.format(date)}</span>
            </button>
          );
        })}
      </div>
      <div data-day={anchorKey} className="flex flex-col gap-2 p-3">
        {dayItems.map((cls) => {
          const start = new Date(cls.startsAt);
          const end = new Date(start.getTime() + cls.durationMin * 60_000);
          return (
            <div key={cls.id} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
              <span aria-hidden="true" className="pt-3 text-xs text-muted-foreground tabular-nums">
                {fmt.time.format(start)}
              </span>
              <div
                data-full={isFull(cls)}
                className={cn('relative rounded-xl border', tileClass(cls))}
              >
                <button
                  type="button"
                  data-class-id={cls.id}
                  onClick={() => onSelectClass(cls)}
                  className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[inherit] py-2.5 pr-10 pl-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="sr-only">{fmt.dayLong.format(start)}, </span>
                  <span className="w-full truncate font-medium">{cls.title}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmt.time.format(start)} - {fmt.time.format(end)}
                  </span>
                  <span className="mt-2">
                    <StatusPill cls={cls} fmt={fmt} t={t} />
                  </span>
                </button>
                <TileMenu cls={cls} t={t} onEdit={onSelectClass} onDelete={onDeleteClass} />
              </div>
            </div>
          );
        })}
        {dayItems.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">{t('studio.classes.empty')}</p>
        ) : null}
        <button
          type="button"
          onClick={() => onCreateAt(createStart)}
          className="rounded-xl px-3 py-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('studio.classes.planning.createAt', { date: fmt.dayLong.format(anchor) })}
        </button>
      </div>
    </div>
  );
}
