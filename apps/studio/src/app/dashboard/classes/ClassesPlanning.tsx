'use client';

import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon, ProhibitIcon, RepeatIcon, UsersIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

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
  /**
   * Edit, delete and create handlers. Leave all three out for a read-only
   * planning (the coach schedule): tiles stop being buttons, the "..." menu
   * and the empty-slot create targets disappear.
   */
  readonly onSelectClass?: (cls: ClassWithRemaining) => void;
  readonly onDeleteClass?: (cls: ClassWithRemaining) => void;
  readonly onCreateAt?: (startsAt: Date) => void;
  readonly onShowDay: (day: Date) => void;
  /** Room id to name (issue #748): tiles name the room their class runs in. */
  readonly roomNames?: ReadonlyMap<string, string>;
  /**
   * The roster page of a class, `null` for a class the viewer may not open.
   * A read-only tile becomes a link to it; an editable tile keeps opening
   * the edit dialog and offers the roster in its "..." menu.
   */
  readonly rosterHref?: (cls: ClassWithRemaining) => string | null;
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

/** Name of the class's room, or null when it has none or the room is unknown. */
function roomOf(
  cls: ClassWithRemaining,
  roomNames: ReadonlyMap<string, string> | undefined,
): string | null {
  return cls.roomId == null ? null : (roomNames?.get(cls.roomId) ?? null);
}

/** "09:00 - 10:00", then the room when there is one. */
function timeAndRoom(fmt: Formatters, start: Date, end: Date, room: string | null): string {
  const time = `${fmt.time.format(start)} - ${fmt.time.format(end)}`;
  return room === null ? time : `${time} · ${room}`;
}

/** ", Room Studio 1" for a screen reader, where the tile has no room to show it. */
function RoomForReader({
  room,
  t,
}: {
  readonly room: string | null;
  readonly t: Translator;
}): ReactElement | null {
  if (room === null) return null;
  return (
    <span className="sr-only">, {t('studio.classes.planning.roomLabel', { name: room })}</span>
  );
}

/** Repeat glyph, with its words for a screen reader, on a class of a series. */
function SeriesMark({
  cls,
  t,
}: {
  readonly cls: ClassWithRemaining;
  readonly t: Translator;
}): ReactElement | null {
  if (cls.seriesId == null) return null;
  return (
    <>
      <RepeatIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">, {t('studio.classes.series.badge')}</span>
    </>
  );
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

/**
 * A class tile's face: a button that opens the class when `onActivate` is
 * given; in a read-only planning, a link to the roster when `href` is set,
 * plain content otherwise.
 */
function TileFace({
  cls,
  onActivate,
  href,
  full,
  className,
  children,
}: {
  readonly cls: ClassWithRemaining;
  readonly onActivate: ((cls: ClassWithRemaining) => void) | undefined;
  readonly href: string | null;
  /** Set on a tile that is its own frame (month cells) for the `[data-full]` styling hook. */
  readonly full?: boolean;
  readonly className: string;
  readonly children: ReactNode;
}): ReactElement {
  if (onActivate === undefined && href !== null) {
    return (
      <Link href={href} data-class-id={cls.id} data-full={full} className={className}>
        {children}
      </Link>
    );
  }
  if (onActivate === undefined) {
    return (
      <div data-class-id={cls.id} data-full={full} className={className}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-class-id={cls.id}
      data-full={full}
      onClick={() => onActivate(cls)}
      className={className}
    >
      {children}
    </button>
  );
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
  rosterHref,
  compact = false,
}: {
  readonly cls: ClassWithRemaining;
  readonly t: Translator;
  readonly onEdit: (cls: ClassWithRemaining) => void;
  readonly onDelete: (cls: ClassWithRemaining) => void;
  readonly rosterHref: string | null;
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
            {rosterHref === null ? null : (
              <Menu.LinkItem
                render={<Link href={rosterHref} />}
                closeOnClick
                className="flex h-8 cursor-default items-center rounded-md px-2 outline-none data-highlighted:bg-muted"
              >
                {t('studio.roster.openRoster')}
              </Menu.LinkItem>
            )}
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
  roomNames,
  rosterHref,
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
              room={roomOf(block.item, roomNames)}
              onSelect={onSelectClass}
              onDelete={onDeleteClass}
              href={rosterHref?.(block.item) ?? null}
            />
          ))}
          {now !== null && key === nowKey ? <NowLine now={now} bounds={bounds} fmt={fmt} /> : null}
          {hours.map((hour) => {
            const start = new Date(date);
            start.setHours(hour, 0, 0, 0);
            const slotClass = 'block h-20 w-full border-t border-border first:border-t-0';
            if (onCreateAt === undefined) return <div key={hour} className={slotClass} />;
            return (
              <button
                key={hour}
                type="button"
                aria-label={t('studio.classes.planning.createAt', {
                  date: fmt.slot.format(start),
                })}
                onClick={() => onCreateAt(start)}
                className={cn(
                  slotClass,
                  'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                )}
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
  readonly room: string | null;
  readonly onSelect: ((cls: ClassWithRemaining) => void) | undefined;
  readonly onDelete: ((cls: ClassWithRemaining) => void) | undefined;
  readonly href: string | null;
}

function WeekBlock({
  block,
  bounds,
  fmt,
  t,
  room,
  onSelect,
  onDelete,
  href,
}: WeekBlockProps): ReactElement {
  const cls = block.item;
  const geometry = blockGeometry(block, bounds);
  const start = new Date(cls.startsAt);
  const end = new Date(start.getTime() + cls.durationMin * 60_000);
  const density = blockDensity(block);
  const editable = onSelect !== undefined && onDelete !== undefined;

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
      <TileFace
        cls={cls}
        onActivate={onSelect}
        href={href}
        className={cn(
          'flex size-full flex-col items-start overflow-hidden rounded-[inherit] px-2.5 text-left text-xs leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          density === 'full' && 'py-2',
          density === 'medium' && 'py-0.5',
          density === 'compact' && 'justify-center',
        )}
      >
        <span className="sr-only">{fmt.dayLong.format(start)}, </span>
        <span
          className={cn(
            'flex w-full min-w-0 items-center gap-1 font-medium',
            density !== 'compact' && editable && 'pr-6',
          )}
        >
          <span className="truncate">{cls.title}</span>
          {density === 'compact' ? null : <SeriesMark cls={cls} t={t} />}
        </span>
        {density === 'compact' ? (
          <span className="sr-only">, {timeAndRoom(fmt, start, end, room)}</span>
        ) : (
          <span className="w-full truncate text-muted-foreground tabular-nums">
            {room === null ? (
              timeAndRoom(fmt, start, end, null)
            ) : (
              <>
                {fmt.time.format(start)}
                <span className="sr-only"> - {fmt.time.format(end)}</span> · {room}
              </>
            )}
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
      </TileFace>
      {density === 'compact' || onSelect === undefined || onDelete === undefined ? null : (
        <TileMenu
          cls={cls}
          t={t}
          onEdit={onSelect}
          onDelete={onDelete}
          rosterHref={href}
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
  roomNames,
  rosterHref,
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
                {(() => {
                  const dayNumber = (
                    <span
                      className={cn(
                        'inline-grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-sm tabular-nums',
                        inMonth ? 'text-foreground' : 'text-muted-foreground',
                        isToday && 'planning-today font-semibold',
                      )}
                    >
                      {date.getDate()}
                    </span>
                  );
                  if (onCreateAt === undefined) {
                    return (
                      <div className="absolute inset-0 flex items-start p-1.5">{dayNumber}</div>
                    );
                  }
                  return (
                    <button
                      type="button"
                      aria-label={t('studio.classes.planning.createAt', {
                        date: fmt.dayLong.format(date),
                      })}
                      onClick={() => onCreateAt(createStart)}
                      className="absolute inset-0 flex items-start p-1.5 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      {dayNumber}
                    </button>
                  );
                })()}
                {shown.map((cls) => (
                  <TileFace
                    key={cls.id}
                    cls={cls}
                    onActivate={onSelectClass}
                    href={rosterHref?.(cls) ?? null}
                    full={isFull(cls)}
                    className={cn(
                      'relative z-10 flex h-6 w-full min-w-0 items-center gap-1.5 rounded-lg border px-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      tileClass(cls),
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      <span className="sr-only">{fmt.dayLong.format(date)}, </span>
                      {fmt.time.format(new Date(cls.startsAt))}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {cls.title}
                      <RoomForReader room={roomOf(cls, roomNames)} t={t} />
                    </span>
                    {isFull(cls) ? (
                      <span className="flex shrink-0 items-center">
                        <ProhibitIcon aria-hidden="true" className="size-3" />
                        <span className="sr-only">, {t('studio.classes.planning.full')}</span>
                      </span>
                    ) : null}
                  </TileFace>
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
  roomNames,
  rosterHref,
}: ClassesPlanningProps): ReactElement {
  const fmt = useFormatters(locale);
  const days = useMemo(() => buildWeekDays(anchor), [anchor]);
  const anchorKey = toDayKey(anchor);
  const dayItems = useMemo(() => groupByDay(items).get(anchorKey) ?? [], [items, anchorKey]);
  const createStart = new Date(anchor);
  createStart.setHours(DEFAULT_CREATE_HOUR, 0, 0, 0);
  const editable = onSelectClass !== undefined && onDeleteClass !== undefined;

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
          const href = rosterHref?.(cls) ?? null;
          return (
            <div key={cls.id} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
              <span aria-hidden="true" className="pt-3 text-xs text-muted-foreground tabular-nums">
                {fmt.time.format(start)}
              </span>
              <div
                data-full={isFull(cls)}
                className={cn('relative rounded-xl border', tileClass(cls))}
              >
                <TileFace
                  cls={cls}
                  onActivate={onSelectClass}
                  href={href}
                  className={cn(
                    'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[inherit] py-2.5 pl-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    editable ? 'pr-10' : 'pr-3',
                  )}
                >
                  <span className="sr-only">{fmt.dayLong.format(start)}, </span>
                  <span className="flex w-full min-w-0 items-center gap-1 font-medium">
                    <span className="truncate">{cls.title}</span>
                    <SeriesMark cls={cls} t={t} />
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground tabular-nums">
                    {timeAndRoom(fmt, start, end, roomOf(cls, roomNames))}
                  </span>
                  <span className="mt-2">
                    <StatusPill cls={cls} fmt={fmt} t={t} />
                  </span>
                </TileFace>
                {onSelectClass === undefined || onDeleteClass === undefined ? null : (
                  <TileMenu
                    cls={cls}
                    t={t}
                    onEdit={onSelectClass}
                    onDelete={onDeleteClass}
                    rosterHref={href}
                  />
                )}
              </div>
            </div>
          );
        })}
        {dayItems.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">{t('studio.classes.empty')}</p>
        ) : null}
        {onCreateAt === undefined ? null : (
          <button
            type="button"
            onClick={() => onCreateAt(createStart)}
            className="rounded-xl px-3 py-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('studio.classes.planning.createAt', { date: fmt.dayLong.format(anchor) })}
          </button>
        )}
      </div>
    </div>
  );
}
