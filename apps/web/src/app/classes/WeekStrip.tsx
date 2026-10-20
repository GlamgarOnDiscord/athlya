/**
 * Week strip above the `/classes` day list (docs/design/ui-direction.md,
 * "Booking calendar"): seven local days, today marked in text, the
 * selected day filled with the brand ink (volt on dark).
 *
 * The days form a tab list with a roving `tabindex`: one tab stop, arrow
 * keys (and Home / End) move between days and select them. The previous
 * and next week buttons sit outside the list. On a phone the days scroll
 * horizontally instead of shrinking below a usable target.
 */
'use client';

import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { localDayKey } from './schedule';

import type { Translator } from '../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

export interface WeekStripProps {
  readonly days: readonly Date[];
  readonly todayKey: string;
  readonly selectedKey: string;
  /** Number of classes per local day key. */
  readonly counts: ReadonlyMap<string, number>;
  readonly panelId: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onSelect: (dayKey: string) => void;
  /** Absent when there is no earlier (or later) week to show. */
  readonly onPreviousWeek?: (() => void) | undefined;
  readonly onNextWeek?: (() => void) | undefined;
}

/** Id of a day's tab, referenced by the tab panel's `aria-labelledby`. */
export function dayTabId(dayKey: string): string {
  return `classes-day-${dayKey}`;
}

export function WeekStrip({
  days,
  todayKey,
  selectedKey,
  counts,
  panelId,
  locale,
  t,
  onSelect,
  onPreviousWeek,
  onNextWeek,
}: WeekStripProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const weekdayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short' }), [locale]);
  const longFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }),
    [locale],
  );
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
    [locale],
  );
  const keys = useMemo(() => days.map(localDayKey), [days]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = keys.indexOf(selectedKey);
      if (index === -1) return;
      let next: number;
      switch (event.key) {
        case 'ArrowRight':
          next = (index + 1) % keys.length;
          break;
        case 'ArrowLeft':
          next = (index - 1 + keys.length) % keys.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = keys.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const key = keys[next];
      if (key === undefined) return;
      onSelect(key);
      listRef.current?.querySelector<HTMLButtonElement>(`#${dayTabId(key)}`)?.focus();
    },
    [keys, selectedKey, onSelect],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium first-letter:uppercase">{monthFmt.format(days[0])}</p>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('classes.week.previous')}
            disabled={onPreviousWeek === undefined}
            onClick={onPreviousWeek}
          >
            <CaretLeftIcon aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('classes.week.next')}
            disabled={onNextWeek === undefined}
            onClick={onNextWeek}
          >
            <CaretRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('classes.week.label')}
        onKeyDown={onKeyDown}
        className="flex snap-x gap-1 overflow-x-auto p-1 sm:gap-2"
      >
        {days.map((day, i) => {
          const key = keys[i] ?? localDayKey(day);
          const selected = key === selectedKey;
          const isToday = key === todayKey;
          const count = counts.get(key) ?? 0;
          return (
            <button
              key={key}
              id={dayTabId(key)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              aria-current={isToday ? 'date' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(key)}
              className={cn(
                'flex min-w-11 flex-1 snap-start flex-col items-center gap-0.5 rounded-lg border px-2 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                selected
                  ? 'week-day-selected border-transparent'
                  : 'border-transparent hover:bg-muted',
                isToday && !selected ? 'border-foreground' : null,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'text-xs',
                  selected ? null : 'text-muted-foreground',
                  isToday ? 'font-semibold' : null,
                )}
              >
                {isToday ? t('classes.week.today') : weekdayFmt.format(day)}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'text-lg leading-tight font-semibold tabular-nums',
                  count === 0 && !selected ? 'text-muted-foreground' : null,
                )}
              >
                {day.getDate()}
              </span>
              <span className="sr-only">
                {`${longFmt.format(day)}${isToday ? `, ${t('classes.week.todayLong')}` : ''}, ${
                  count === 0
                    ? t('classes.week.noClass')
                    : count === 1
                      ? t('classes.week.classCountOne')
                      : t('classes.week.classCount', { count })
                }`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
