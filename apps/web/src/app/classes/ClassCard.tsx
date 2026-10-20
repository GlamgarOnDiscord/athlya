'use client';

import { CheckCircleIcon, HourglassMediumIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { capacityView } from './schedule';

import type { MemberBooking } from '../../lib/api/reservations';
import type { Translator } from '../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

export interface ClassCardInfo {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly durationMin: number;
  readonly capacity: number;
  readonly remaining: number;
  readonly coachName?: string | undefined;
}

export interface ClassCardProps {
  readonly classInfo: ClassCardInfo;
  readonly t: Translator;
  readonly locale: Locale;
  readonly onBook: (classId: string) => Promise<void>;
  /** The member's own place in this class, when they hold one. */
  readonly booking?: MemberBooking | null;
  readonly disabled?: boolean;
  readonly error?: string | null;
}

/**
 * One class of the `/classes` day list: start time and duration first,
 * then the title, the capacity (text and bar say the same thing: seats
 * taken out of the capacity) and the action. A held place replaces the
 * action with its state, in text: booked, or the waitlist position.
 */
export function ClassCard({
  classInfo,
  t,
  locale,
  onBook,
  booking = null,
  disabled = false,
  error = null,
}: ClassCardProps): ReactElement {
  const { id, title, startsAt, durationMin, capacity, remaining, coachName } = classInfo;

  const seats = capacityView(capacity, remaining);
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  );
  const startLabel = timeFmt.format(new Date(startsAt));
  const titleId = `class-card-${id}-title`;
  const errorSlotId = `class-card-${id}-error`;
  const capacityTrackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    capacityTrackRef.current?.style.setProperty('--bar-scale', String(seats.ratio));
  }, [seats.ratio]);

  const onClick = useCallback(() => {
    void onBook(id);
  }, [id, onBook]);

  const seatsLabel = seats.full
    ? t('classes.card.fullWaitlist')
    : seats.remaining === 1
      ? t('classes.card.placeLeft')
      : t('classes.card.placesLeft', { count: seats.remaining });

  return (
    <Card aria-labelledby={titleId} className="py-0">
      <div className="flex gap-4 p-4">
        <div className="flex w-16 shrink-0 flex-col">
          <time dateTime={startsAt} className="text-2xl leading-none font-semibold tabular-nums">
            {startLabel}
          </time>
          <span className="mt-1.5 text-sm text-muted-foreground">
            {t('classes.card.duration', { minutes: durationMin })}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <CardTitle id={titleId} className="font-semibold">
              {title}
            </CardTitle>
            {coachName !== undefined && coachName !== '' ? (
              <p className="text-sm text-muted-foreground">{coachName}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className={cn(seats.full ? 'font-medium' : null)}>{seatsLabel}</span>
              <span className="text-muted-foreground tabular-nums">
                {t('classes.card.taken', { taken: seats.taken, capacity: seats.capacity })}
              </span>
            </div>
            <div
              ref={capacityTrackRef}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="class-card-capacity-bar class-capacity-fill h-full w-full origin-left rounded-full transition-transform motion-reduce:transition-none"
                role="presentation"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {booking !== null ? (
              <>
                {booking.kind === 'confirmed' ? (
                  <p className="flex items-center gap-1.5 font-medium text-success">
                    <CheckCircleIcon weight="fill" className="size-5" aria-hidden="true" />
                    {t('classes.card.booked')}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 font-medium">
                    <HourglassMediumIcon className="size-5" aria-hidden="true" />
                    {booking.position !== undefined
                      ? t('classes.card.waitlistPosition', { position: booking.position })
                      : t('classes.card.onWaitlist')}
                  </p>
                )}
                <Link
                  href="/me"
                  className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  {t('classes.card.manage')}
                </Link>
              </>
            ) : seats.full ? (
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
          </div>

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
        </div>
      </div>
    </Card>
  );
}
