'use client';

import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { CARD, LABEL, MiniBars } from './parts';

import type { ReactElement } from 'react';

export interface KpiDelta {
  /** Signed change, already formatted ("+12 %", "-4 pts", "+1"). */
  readonly text: string;
  readonly direction: 'up' | 'down' | 'flat';
  readonly context: string;
}

interface KpiTileProps {
  readonly label: string;
  readonly value: string | null;
  readonly unit?: string;
  readonly delta: KpiDelta | null;
  readonly trend: ReadonlyArray<number | null> | null;
  readonly failed: string | null;
  readonly href: string;
  readonly linkLabel: string;
}

const DELTA_ICON = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: ArrowRightIcon };

/** One number, its label, its change against the previous period and a sparkline. */
export function KpiTile({
  label,
  value,
  unit,
  delta,
  trend,
  failed,
  href,
  linkLabel,
}: KpiTileProps): ReactElement {
  const DeltaIcon = delta === null ? null : DELTA_ICON[delta.direction];
  return (
    <section className={cn(CARD, 'relative gap-3 p-4 lg:col-span-3')}>
      <h2 className={LABEL}>
        <Link
          href={href}
          className="rounded-sm after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          title={linkLabel}
        >
          {label}
        </Link>
      </h2>
      <div className="flex items-end justify-between gap-3">
        {failed !== null ? (
          <p className="text-sm text-destructive">{failed}</p>
        ) : value === null ? (
          <Skeleton className="h-9 w-20" />
        ) : (
          <p className="flex items-baseline gap-1">
            <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">
              {value}
            </span>
            {unit === undefined ? null : (
              <span className="text-sm text-muted-foreground">{unit}</span>
            )}
          </p>
        )}
        {trend === null ? null : <MiniBars values={trend} />}
      </div>
      <p className="flex min-h-4 items-center gap-1 text-xs text-muted-foreground">
        {delta === null || DeltaIcon === null ? null : (
          <>
            <DeltaIcon
              aria-hidden="true"
              className={cn(
                'size-3.5',
                delta.direction === 'up' && 'text-success',
                delta.direction === 'down' && 'text-destructive',
              )}
            />
            <span
              className={cn(
                'font-medium tabular-nums',
                delta.direction === 'up' && 'text-success',
                delta.direction === 'down' && 'text-destructive',
              )}
            >
              {delta.text}
            </span>
            <span>{delta.context}</span>
          </>
        )}
      </p>
    </section>
  );
}
