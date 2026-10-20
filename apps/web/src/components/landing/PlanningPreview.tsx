/**
 * Static composition of the product for the landing: the studio week
 * schedule next to a member's bookings, with the states the app really
 * shows (spots left, full, booked, waitlist position, checked in).
 *
 * It is an illustration, not live data: the parent `<figure>` carries a
 * caption, and this block is hidden from assistive technology so the
 * fictional classes are not read out as content. Built from the landing
 * tokens only, so it follows the brand without a screenshot to maintain.
 */
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';

import { cn } from '@/lib/utils';

import type { Translator } from '../../lib/i18n/t';
import type { ReactElement } from 'react';

type ClassKey =
  'classCross' | 'classBoxing' | 'classPilates' | 'classMobility' | 'classHiit' | 'classYoga';

type DayKey = 'dayMon' | 'dayTue' | 'dayWed' | 'dayThu' | 'dayFri';

interface Slot {
  readonly name: ClassKey;
  readonly time: string;
  /** Spots left; 0 means full. */
  readonly spots: number;
}

const WEEK: ReadonlyArray<{ readonly day: DayKey; readonly slots: readonly Slot[] }> = [
  {
    day: 'dayMon',
    slots: [
      { name: 'classCross', time: '07:00', spots: 0 },
      { name: 'classPilates', time: '12:15', spots: 3 },
    ],
  },
  {
    day: 'dayTue',
    slots: [
      { name: 'classMobility', time: '07:30', spots: 6 },
      { name: 'classBoxing', time: '18:30', spots: 3 },
    ],
  },
  {
    day: 'dayWed',
    slots: [
      { name: 'classHiit', time: '12:15', spots: 0 },
      { name: 'classYoga', time: '19:00', spots: 5 },
    ],
  },
  {
    day: 'dayThu',
    slots: [
      { name: 'classPilates', time: '07:30', spots: 2 },
      { name: 'classBoxing', time: '18:30', spots: 0 },
    ],
  },
  {
    day: 'dayFri',
    slots: [
      { name: 'classCross', time: '07:00', spots: 4 },
      { name: 'classMobility', time: '12:15', spots: 8 },
    ],
  },
];

type BookingState = 'booked' | 'waitlist' | 'checkedIn';

const BOOKINGS: ReadonlyArray<{
  readonly name: ClassKey;
  readonly day: DayKey;
  readonly time: string;
  readonly state: BookingState;
}> = [
  { name: 'classBoxing', day: 'dayTue', time: '18:30', state: 'booked' },
  { name: 'classBoxing', day: 'dayThu', time: '18:30', state: 'waitlist' },
  { name: 'classCross', day: 'dayMon', time: '07:00', state: 'checkedIn' },
];

const CHIP = 'inline-flex h-5 self-start items-center gap-1 rounded-sm px-1.5 text-xs font-medium';

function SlotCard({ slot, t }: { readonly slot: Slot; readonly t: Translator }): ReactElement {
  const full = slot.spots === 0;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-2.5">
      <div className="min-w-0">
        <p className="line-clamp-2 min-h-8 text-xs font-semibold text-foreground">
          {t(`web.home.product.${slot.name}`)}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">{slot.time}</p>
      </div>
      <span
        className={cn(
          CHIP,
          full
            ? 'border border-border text-muted-foreground'
            : 'bg-primary text-primary-foreground',
        )}
      >
        {full ? t('web.home.product.full') : t('web.home.product.spotsLeft', { count: slot.spots })}
      </span>
    </div>
  );
}

function BookingChip({
  state,
  t,
}: {
  readonly state: BookingState;
  readonly t: Translator;
}): ReactElement {
  if (state === 'booked') {
    return (
      <span className={cn(CHIP, 'bg-primary text-primary-foreground')}>
        <CheckIcon weight="bold" className="size-3" />
        {t('web.home.product.booked')}
      </span>
    );
  }
  if (state === 'waitlist') {
    return (
      <span className={cn(CHIP, 'border border-border text-foreground')}>
        {t('web.home.product.waitlist')}
      </span>
    );
  }
  return (
    <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
      {t('web.home.product.checkedIn')}
    </span>
  );
}

export function PlanningPreview({ t }: { readonly t: Translator }): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="grid gap-3 rounded-3xl border border-border bg-card p-3 select-none lg:grid-cols-[minmax(0,1fr)_15rem]"
    >
      <div className="rounded-xl border border-border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold">{t('web.home.product.studioLabel')}</p>
          <div className="flex rounded-md bg-muted p-0.5 text-xs">
            <span className="rounded-sm bg-foreground px-2 py-1 font-medium text-background">
              {t('web.home.product.viewWeek')}
            </span>
            <span className="px-2 py-1 text-muted-foreground">
              {t('web.home.product.viewMonth')}
            </span>
            <span className="px-2 py-1 text-muted-foreground">
              {t('web.home.product.viewList')}
            </span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {WEEK.map(({ day, slots }, index) => (
            <div key={day} className={cn('flex flex-col gap-2', index > 2 && 'hidden sm:flex')}>
              <p className="border-b border-border pb-2 text-xs text-muted-foreground">
                {t(`web.home.product.${day}`)}
              </p>
              {slots.map((slot) => (
                <SlotCard key={`${slot.name}-${slot.time}`} slot={slot} t={t} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-background p-4">
        <p className="text-sm font-semibold">{t('web.home.product.memberLabel')}</p>
        <ul className="mt-4 flex flex-col">
          {BOOKINGS.map((booking) => (
            <li
              key={`${booking.day}-${booking.name}`}
              className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {t(`web.home.product.${booking.name}`)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t(`web.home.product.${booking.day}`)} {booking.time}
                </p>
              </div>
              <BookingChip state={booking.state} t={t} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
