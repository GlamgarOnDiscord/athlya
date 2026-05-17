'use client';

import { useCallback, useMemo, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { Translator } from '../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

export interface ClassCardInfo {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly capacity: number;
  readonly remaining: number;
  readonly coachName?: string | undefined;
}

export interface ClassCardProps {
  readonly classInfo: ClassCardInfo;
  readonly t: Translator;
  readonly locale: Locale;
  readonly onBook: (classId: string) => Promise<void>;
  readonly booked?: boolean;
  readonly disabled?: boolean;
  readonly error?: string | null;
}

export function ClassCard({
  classInfo,
  t,
  locale,
  onBook,
  booked = false,
  disabled = false,
  error = null,
}: ClassCardProps): ReactElement {
  const { id, title, startsAt, capacity, remaining, coachName } = classInfo;

  const isFull = remaining <= 0;
  const pct = capacity > 0 ? Math.round(((capacity - remaining) / capacity) * 100) : 100;
  const barColor = pct >= 90 ? 'bg-destructive' : pct >= 60 ? 'bg-amber-500' : 'bg-primary';
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );
  const startLabel = fmt.format(new Date(startsAt));
  const errorSlotId = `class-card-${id}-error`;

  const onClick = useCallback(() => {
    void onBook(id);
  }, [id, onBook]);

  return (
    <Card aria-labelledby={`class-card-${id}-title`}>
      <CardHeader>
        <CardTitle id={`class-card-${id}-title`}>{title}</CardTitle>
        {coachName !== undefined && coachName !== '' ? (
          <p className="text-sm text-muted-foreground">{coachName}</p>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-sm">
            <span>{t('classes.card.remaining')}</span>
            <span className="font-medium">
              {remaining} / {capacity}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', barColor)}
              style={{ width: `${pct}%` }}
              role="presentation"
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          <time dateTime={startsAt}>{startLabel}</time>
        </p>
      </CardContent>

      <CardFooter className="flex flex-col items-start gap-2">
        {booked ? (
          <Button
            disabled
            variant="secondary"
            aria-label={`${t('classes.card.booked')} — ${title}`}
          >
            {t('classes.card.booked')}
          </Button>
        ) : isFull ? (
          <Button
            onClick={onClick}
            disabled={disabled}
            variant="outline"
            aria-label={`${t('classes.card.joinWaitlist')} — ${title}`}
            aria-describedby={error !== null ? errorSlotId : undefined}
          >
            {t('classes.card.joinWaitlist')}
          </Button>
        ) : (
          <Button
            onClick={onClick}
            disabled={disabled}
            aria-label={`${t('classes.card.book')} — ${title}`}
            aria-describedby={error !== null ? errorSlotId : undefined}
          >
            {t('classes.card.book')}
          </Button>
        )}

        {error !== null ? (
          <span
            id={errorSlotId}
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {error}
          </span>
        ) : null}
      </CardFooter>
    </Card>
  );
}
