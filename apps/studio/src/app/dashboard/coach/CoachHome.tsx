'use client';

/**
 * `/dashboard` for a coach: the class running now or the next one with a
 * countdown, the coach's classes of the day and of the coming week, and
 * the way to the check-in kiosk. Classes come from `GET /v1/classes`
 * (open to any signed-in user) and are kept when `coachId` is the coach.
 * Nothing is invented: without an assigned class the cards say so.
 */
import { ScanIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { classRosterHref } from '../../../lib/links';
import { useNowMinute } from '../../../lib/use-now-minute';
import { useTodayKey } from '../classes/planning-clock';
import { bookedSeats } from '../dashboard-summary';
import { formatDuration } from '../format-duration';
import {
  CARD,
  CardHeader,
  CardLink,
  CardMessage,
  FillMeter,
  RowsSkeleton,
} from '../overview/parts';
import { TodayTimeline } from '../overview/TodayTimeline';
import { UpcomingTable } from '../overview/UpcomingTable';

import { agendaRange, coachAgenda, type AssignedClass, type CoachFocus } from './coach-agenda';

import type { Locale } from '@athlya/shared/i18n';

type Load =
  { kind: 'loading' } | { kind: 'ready'; items: ReadonlyArray<AssignedClass> } | { kind: 'error' };

const PLANNING_HREF = '/dashboard/planning';
/**
 * The kiosk is entered with a full document load: it is served with its
 * own camera permissions policy, which a client-side transition would not
 * pick up (`next.config.ts`).
 */
const KIOSK_HREF = '/dashboard/checkin';

export function CoachHome(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken, user } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const nowMinute = useNowMinute();
  const now = useMemo(
    () => (nowMinute === null ? null : new Date(nowMinute * 60_000)),
    [nowMinute],
  );

  const [classes, setClasses] = useState<Load>({ kind: 'loading' });
  // Refetch at local midnight so the agenda window moves with the day.
  const todayKey = useTodayKey();

  useEffect(() => {
    if (todayKey === null) return;
    let cancelled = false;
    const { from, to } = agendaRange(new Date());
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    void client
      .get<{ items: ReadonlyArray<AssignedClass> }>(`/v1/classes?${query.toString()}`)
      .then(
        (res) => !cancelled && setClasses({ kind: 'ready', items: res.items }),
        () => !cancelled && setClasses({ kind: 'error' }),
      );
    return () => {
      cancelled = true;
    };
  }, [client, todayKey]);

  const agenda = useMemo(
    () =>
      now !== null && user !== null && classes.kind === 'ready'
        ? coachAgenda(classes.items, user.id, now)
        : null,
    [classes, now, user],
  );

  const firstName = user?.displayName.trim().split(/\s+/u)[0] ?? '';
  const failed = classes.kind === 'error';
  const nothingAssigned =
    agenda !== null &&
    agenda.focus.kind === 'none' &&
    agenda.today.length === 0 &&
    agenda.upcoming.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={
          firstName === ''
            ? t('studio.nav.home')
            : t('studio.dashboard.greeting', { name: firstName })
        }
        subtitle={
          now === null ? (
            <Skeleton className="h-4 w-48" />
          ) : (
            <span className="inline-block first-letter:uppercase">
              {new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              }).format(now)}
            </span>
          )
        }
        actions={
          <a href={KIOSK_HREF} className={buttonVariants({ size: 'lg' })}>
            <ScanIcon aria-hidden="true" data-icon="inline-start" />
            {t('studio.dashboard.actions.openKiosk')}
          </a>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section aria-labelledby="coach-next" className={cn(CARD, 'lg:col-span-4')}>
          <CardHeader id="coach-next" title={t('studio.coach.next.title')} />
          {failed ? (
            <CardMessage text={t('studio.coach.loadError')} />
          ) : agenda === null || now === null ? (
            <RowsSkeleton rows={3} />
          ) : (
            <NextClass
              focus={agenda.focus}
              now={now}
              hint={nothingAssigned ? t('studio.coach.unassigned') : null}
              locale={locale}
              t={t}
            />
          )}
        </section>

        <section aria-labelledby="coach-today" className={cn(CARD, 'lg:col-span-8')}>
          <CardHeader
            id="coach-today"
            title={t('studio.coach.today.title')}
            detail={
              agenda === null
                ? null
                : t(
                    pluralKey(locale, agenda.today.length, {
                      one: 'studio.dashboard.today.countOne',
                      other: 'studio.dashboard.today.countOther',
                    }),
                    { count: agenda.today.length },
                  )
            }
            action={<CardLink href={PLANNING_HREF} label={t('studio.nav.planning')} />}
          />
          {failed ? (
            <CardMessage text={t('studio.coach.loadError')} />
          ) : agenda === null || now === null ? (
            <RowsSkeleton rows={3} />
          ) : agenda.today.length === 0 ? (
            <CardMessage text={t('studio.coach.today.empty')} />
          ) : (
            <TodayTimeline
              classes={agenda.today}
              next={agenda.next}
              now={now}
              locale={locale}
              t={t}
            />
          )}
        </section>

        <section aria-labelledby="coach-upcoming" className={cn(CARD, 'lg:col-span-12')}>
          <CardHeader
            id="coach-upcoming"
            title={t('studio.coach.upcoming.title')}
            detail={t('studio.dashboard.upcoming.window')}
          />
          {failed ? (
            <CardMessage text={t('studio.coach.loadError')} />
          ) : agenda === null ? (
            <RowsSkeleton rows={3} />
          ) : agenda.upcoming.length === 0 ? (
            <CardMessage text={t('studio.coach.upcoming.empty')} />
          ) : (
            <UpcomingTable classes={agenda.upcoming} locale={locale} t={t} />
          )}
        </section>
      </div>
    </div>
  );
}

function NextClass({
  focus,
  now,
  hint,
  locale,
  t,
}: {
  readonly focus: CoachFocus<AssignedClass>;
  readonly now: Date;
  readonly hint: string | null;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  if (focus.kind === 'none') {
    return (
      <div className="flex flex-col gap-1 px-4 py-6 text-sm">
        <p className="font-medium">{t('studio.coach.next.empty')}</p>
        {hint === null ? null : <p className="text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  const { cls } = focus;
  const start = new Date(cls.startsAt);
  const end = new Date(start.getTime() + cls.durationMin * 60_000);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const sameDay = start.toDateString() === now.toDateString();
  const day = sameDay
    ? t('studio.classes.planning.today')
    : new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(
        start,
      );
  const booked = bookedSeats(cls);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-col items-start gap-2">
        {focus.kind === 'live' ? (
          <span className="planning-pill-open inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium">
            {t('studio.dashboard.today.live')}
          </span>
        ) : null}
        <p className="text-2xl font-semibold tracking-tight tabular-nums first-letter:uppercase sm:text-3xl">
          {focus.kind === 'live'
            ? t('studio.coach.next.endsIn', { time: formatDuration(focus.minutesLeft, t) })
            : t('studio.dashboard.today.inTime', { time: formatDuration(focus.minutes, t) })}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={classRosterHref(cls.id)}
          className="w-fit max-w-full truncate rounded-sm text-base font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {cls.title}
        </Link>
        <p className="text-sm text-muted-foreground tabular-nums first-letter:uppercase">
          {t('studio.coach.next.at', {
            day,
            start: time.format(start),
            end: time.format(end),
          })}
        </p>
      </div>
      <div className="mt-auto">
        <FillMeter
          booked={booked}
          capacity={cls.capacity}
          label={t('studio.dashboard.today.fillLabel', { booked, capacity: cls.capacity })}
        />
      </div>
    </div>
  );
}
