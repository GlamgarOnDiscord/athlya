'use client';

/** Shared building blocks of the dashboard cards: frame, header, label, marks. */
import { ArrowRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export const CARD =
  'flex min-w-0 flex-col rounded-lg border border-border bg-card text-card-foreground';
export const LABEL = 'text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase';
export const LINK =
  'inline-flex items-center gap-1 rounded-sm text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface CardHeaderProps {
  readonly id: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly action?: ReactNode;
}

export function CardHeader({ id, title, detail, action }: CardHeaderProps): ReactElement {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2">
      <h2 id={id} className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
        {title}
        {detail === undefined || detail === null ? null : (
          <span className="truncate text-xs font-normal text-muted-foreground">{detail}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

export function CardLink({
  href,
  label,
}: {
  readonly href: string;
  readonly label: string;
}): ReactElement {
  return (
    <Link href={href} className={LINK}>
      {label}
      <ArrowRightIcon aria-hidden="true" className="size-3" />
    </Link>
  );
}

export function CardMessage({ text }: { readonly text: string }): ReactElement {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{text}</p>;
}

export function RowsSkeleton({ rows }: { readonly rows: number }): ReactElement {
  return (
    <ul className="divide-y divide-border" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={`skeleton-${String(i)}`} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12" />
        </li>
      ))}
    </ul>
  );
}

/** A bar whose height is a share of its track, set from CSSOM (strict CSP, no style=""). */
export function MarkBar({
  ratio,
  accent,
  className,
}: {
  readonly ratio: number;
  readonly accent: boolean;
  readonly className?: string;
}): ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    ref.current?.style.setProperty('--h', `${String(Math.max(0.04, Math.min(1, ratio)) * 100)}%`);
  }, [ratio]);
  return (
    <span
      ref={ref}
      className={cn(
        'mark-bar block w-full rounded-sm',
        accent ? 'mark-accent' : 'bg-muted-foreground/30',
        className,
      )}
    />
  );
}

/**
 * Inline sparkline of bars over a baseline, the last value (current period)
 * in the accent. An empty period draws no bar, so it reads as the baseline
 * rather than as a stray dash.
 */
export function MiniBars({
  values,
}: {
  readonly values: ReadonlyArray<number | null>;
}): ReactElement {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-20 shrink-0 items-end gap-0.5 border-b border-border"
    >
      {values.map((value, index) => (
        <span key={`bar-${String(index)}`} className="flex h-full flex-1 items-end">
          {value === null || value <= 0 ? null : (
            <MarkBar ratio={value / max} accent={index === values.length - 1} />
          )}
        </span>
      ))}
    </span>
  );
}

/** Booked seats over capacity; the width is set from CSSOM. */
export function FillMeter({
  booked,
  capacity,
  label,
}: {
  readonly booked: number;
  readonly capacity: number;
  readonly label: string;
}): ReactElement {
  const barRef = useRef<HTMLSpanElement | null>(null);
  const ratio = capacity === 0 ? 0 : Math.min(1, booked / capacity);
  useEffect(() => {
    barRef.current?.style.setProperty('--fill', `${String(ratio * 100)}%`);
  }, [ratio]);
  return (
    <span className="flex items-center gap-3" role="img" aria-label={label}>
      <span
        aria-hidden="true"
        className="h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-muted"
      >
        <span ref={barRef} className="fill-meter-bar block h-full rounded-full bg-chart-1" />
      </span>
      <span aria-hidden="true" className="w-14 shrink-0 text-right text-sm tabular-nums">
        {booked}/{capacity}
      </span>
    </span>
  );
}
