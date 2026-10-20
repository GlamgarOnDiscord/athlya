'use client';

/**
 * Header of a planning screen: the period on show, the view switch and
 * the today / previous / next controls. Shared by the admin classes page
 * and the coach schedule, which add their own actions after the arrows.
 */
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useMemo, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { buildWeekDays, type PlanningView } from './planning-grid';

import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

export type ToolbarView = PlanningView | 'list';

/** "Tuesday 20 October 2026", "19 - 25 October 2026" or "October 2026". */
export function periodLabel(view: ToolbarView, anchor: Date, locale: Locale): string {
  if (view === 'day') {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(anchor);
  }
  if (view === 'month' || view === 'list') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
  }
  const days = buildWeekDays(anchor);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatRange(days[0] ?? anchor, days[6] ?? anchor);
}

const STEP_KEYS = {
  day: ['studio.classes.planning.previousDay', 'studio.classes.planning.nextDay'],
  week: ['studio.classes.planning.previousWeek', 'studio.classes.planning.nextWeek'],
  month: ['studio.classes.planning.previousMonth', 'studio.classes.planning.nextMonth'],
  list: ['studio.classes.planning.previousMonth', 'studio.classes.planning.nextMonth'],
} as const;

/** A row of pressed / not pressed buttons that picks one option, such as the view. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col rounded-lg border border-border bg-muted p-0.5 md:inline-grid"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === option.value &&
              'bg-background text-foreground shadow-sm dark:bg-foreground dark:text-background dark:hover:text-background',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface PlanningToolbarProps<V extends ToolbarView> {
  readonly view: V;
  readonly views: ReadonlyArray<V>;
  /** `null` until the browser knows today's date. */
  readonly anchor: Date | null;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onViewChange: (view: V) => void;
  readonly onToday: () => void;
  readonly onStep: (direction: -1 | 1) => void;
  /** Page actions placed after the arrows, such as "New class". */
  readonly children?: ReactNode;
}

export function PlanningToolbar<V extends ToolbarView>({
  view,
  views,
  anchor,
  locale,
  t,
  onViewChange,
  onToday,
  onStep,
  children,
}: PlanningToolbarProps<V>): ReactElement {
  const label = useMemo(
    () => (anchor === null ? null : periodLabel(view, anchor, locale)),
    [anchor, locale, view],
  );
  const [previousKey, nextKey] = STEP_KEYS[view];

  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
      {label === null ? (
        <Skeleton className="h-7 w-56" />
      ) : (
        <h2 aria-live="polite" className="text-lg font-semibold first-letter:uppercase">
          {label}
        </h2>
      )}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        {views.length > 1 ? (
          <SegmentedControl
            label={t('studio.classes.planning.viewLabel')}
            options={views.map((option) => ({
              value: option,
              label: t(`studio.classes.planning.views.${option}`),
            }))}
            value={view}
            onChange={onViewChange}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onToday}>
            {t('studio.classes.planning.today')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(previousKey)}
            onClick={() => onStep(-1)}
          >
            <CaretLeftIcon aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t(nextKey)} onClick={() => onStep(1)}>
            <CaretRightIcon aria-hidden="true" />
          </Button>
          {children}
        </div>
      </div>
    </div>
  );
}
