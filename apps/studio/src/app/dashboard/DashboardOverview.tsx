'use client';

/**
 * `/dashboard` overview. Every number is read from endpoints the console
 * already uses: `GET /v1/classes` (twelve past weeks and the current two,
 * in two calls because the API caps a range at 90 days), `GET /v1/members`
 * (walked for the count and the sign-up trend) and `GET /v1/audit`. A card
 * whose source fails says so; a card without data says that instead of
 * drawing zeros.
 */
import {
  BookOpenIcon,
  CalendarBlankIcon,
  CaretRightIcon,
  CreditCardIcon,
  ListBulletsIcon,
  PaletteIcon,
  PlusIcon,
  ScanIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { startOfWeek } from 'date-fns';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { PageHeader } from '../../components/shell/PageHeader';
import { useApiClient } from '../../lib/api/buildClient';
import { fetchMemberDirectory, type StudioMember } from '../../lib/api/members';
import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { pluralKey } from '../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../lib/i18n/t';
import { useNowMinute } from '../../lib/use-now-minute';

import {
  actionLabel,
  formatEventDate,
  formatEventTime,
  type AuditItem,
} from './audit/audit-format';
import {
  minutesUntil,
  newMembersPerWeek,
  overviewRanges,
  summarize,
  type OverviewClass,
} from './dashboard-summary';
import { formatDuration } from './format-duration';
import { BookingsChart } from './overview/BookingsChart';
import { KpiTile, type KpiDelta } from './overview/KpiTile';
import { OccupancyCard } from './overview/OccupancyCard';
import { CARD, CardHeader, CardLink, CardMessage, RowsSkeleton } from './overview/parts';
import { TodayTimeline } from './overview/TodayTimeline';
import { UpcomingTable } from './overview/UpcomingTable';

import type { TranslationKeys } from '@athlya/shared/i18n';

type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error' };

const ACTIVITY_LIMIT = 6;
const MEMBER_TREND_WEEKS = 8;

interface Section {
  readonly href: string;
  readonly icon: Icon;
  readonly titleKey: TranslationKeys;
  readonly bodyKey: TranslationKeys;
}

const SECTIONS: ReadonlyArray<Section> = [
  {
    href: '/dashboard/classes',
    icon: CalendarBlankIcon,
    titleKey: 'studio.dashboard.classes.title',
    bodyKey: 'studio.dashboard.classes.body',
  },
  {
    href: '/dashboard/programs',
    icon: BookOpenIcon,
    titleKey: 'studio.dashboard.programs.title',
    bodyKey: 'studio.dashboard.programs.body',
  },
  {
    href: '/dashboard/members',
    icon: UsersIcon,
    titleKey: 'studio.dashboard.members.title',
    bodyKey: 'studio.dashboard.members.body',
  },
  {
    href: '/dashboard/checkin',
    icon: ScanIcon,
    titleKey: 'studio.dashboard.checkin.title',
    bodyKey: 'studio.dashboard.checkin.body',
  },
  {
    href: '/dashboard/branding',
    icon: PaletteIcon,
    titleKey: 'studio.dashboard.branding.title',
    bodyKey: 'studio.dashboard.branding.body',
  },
  {
    href: '/dashboard/billing',
    icon: CreditCardIcon,
    titleKey: 'studio.dashboard.billing.title',
    bodyKey: 'studio.dashboard.billing.body',
  },
  {
    href: '/dashboard/audit',
    icon: ListBulletsIcon,
    titleKey: 'studio.dashboard.audit.title',
    bodyKey: 'studio.dashboard.audit.body',
  },
];

function signed(value: number, suffix: string, locale: string): string {
  const n = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }).format(value);
  return suffix === '' ? n : `${n} ${suffix}`;
}

function direction(value: number): KpiDelta['direction'] {
  if (value > 0) return 'up';
  return value < 0 ? 'down' : 'flat';
}

export function DashboardOverview(): ReactElement {
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

  const [classes, setClasses] = useState<Load<ReadonlyArray<OverviewClass>>>({ kind: 'loading' });
  const [members, setMembers] = useState<
    Load<{ items: ReadonlyArray<StudioMember>; complete: boolean }>
  >({
    kind: 'loading',
  });
  const [activity, setActivity] = useState<Load<ReadonlyArray<AuditItem>>>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const { history, current } = overviewRanges(new Date());
    const read = (from: Date, to: Date): Promise<{ items: ReadonlyArray<OverviewClass> }> =>
      client.get(
        `/v1/classes?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString()}`,
      );
    void Promise.all([read(history.from, history.to), read(current.from, current.to)]).then(
      ([past, coming]) =>
        !cancelled && setClasses({ kind: 'ready', value: [...past.items, ...coming.items] }),
      () => !cancelled && setClasses({ kind: 'error' }),
    );
    void fetchMemberDirectory(client).then(
      (dir) => !cancelled && setMembers({ kind: 'ready', value: dir }),
      () => !cancelled && setMembers({ kind: 'error' }),
    );
    void client.get<{ items: ReadonlyArray<AuditItem> }>(`/v1/audit?limit=${ACTIVITY_LIMIT}`).then(
      (res) =>
        !cancelled && setActivity({ kind: 'ready', value: res.items.slice(0, ACTIVITY_LIMIT) }),
      () => !cancelled && setActivity({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const summary = useMemo(
    () => (now !== null && classes.kind === 'ready' ? summarize(classes.value, now) : null),
    [classes, now],
  );
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const loadError = t('studio.dashboard.loadError');
  const classesFailed = classes.kind === 'error' ? loadError : null;
  const weekStart = now === null ? null : startOfWeek(now, { weekStartsOn: 1 });
  const todayIndex = now === null ? 0 : (now.getDay() + 6) % 7;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' });

  const firstName = user?.displayName.trim().split(/\s+/u)[0] ?? '';
  const nextLine =
    summary === null || now === null
      ? null
      : summary.next === null
        ? t('studio.dashboard.noNext')
        : t('studio.dashboard.nextIn', {
            time: formatDuration(minutesUntil(summary.next.startsAt, now), t),
          });

  const deltas = summary === null || !summary.hasHistory ? null : summary;
  const memberTrend =
    members.kind === 'ready' && now !== null && members.value.complete
      ? newMembersPerWeek(
          members.value.items.map((m) => m.createdAt),
          now,
          MEMBER_TREND_WEEKS,
        )
      : null;
  const newThisWeek = memberTrend?.at(-1) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={
          firstName === ''
            ? t('studio.dashboard.title')
            : t('studio.dashboard.greeting', { name: firstName })
        }
        subtitle={
          now === null ? (
            <Skeleton className="h-4 w-64" />
          ) : (
            <span className="first-letter:uppercase">
              {new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              }).format(now)}
              {nextLine === null ? null : ` · ${nextLine}`}
            </span>
          )
        }
        actions={
          <>
            <Link
              href="/dashboard/checkin"
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              <ScanIcon aria-hidden="true" data-icon="inline-start" />
              {t('studio.dashboard.actions.openKiosk')}
            </Link>
            <Link href="/dashboard/classes?new=1" className={buttonVariants({ size: 'lg' })}>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              {t('studio.shell.newClass')}
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12">
        <KpiTile
          label={t('studio.dashboard.tiles.todayClasses')}
          value={summary === null ? null : number.format(summary.today.length)}
          delta={
            deltas === null || now === null
              ? null
              : {
                  text: signed(deltas.today.length - deltas.sameDayLastWeek, '', locale),
                  direction: direction(deltas.today.length - deltas.sameDayLastWeek),
                  context: t('studio.dashboard.tiles.vsSameDay', { day: weekday.format(now) }),
                }
          }
          trend={summary?.classesTrend ?? null}
          failed={classesFailed}
          href="/dashboard/classes"
          linkLabel={t('studio.dashboard.tiles.openPlanning')}
        />
        <KpiTile
          label={t('studio.dashboard.tiles.weekBookings')}
          value={summary === null ? null : number.format(summary.week.booked)}
          delta={
            deltas === null || deltas.previousWeek.booked === 0
              ? null
              : (() => {
                  const change = Math.round(
                    ((deltas.week.booked - deltas.previousWeek.booked) /
                      deltas.previousWeek.booked) *
                      100,
                  );
                  return {
                    text: signed(change, '%', locale),
                    direction: direction(change),
                    context: t('studio.dashboard.tiles.vsPreviousWeek'),
                  };
                })()
          }
          trend={summary?.bookingsTrend ?? null}
          failed={classesFailed}
          href="/dashboard/classes"
          linkLabel={t('studio.dashboard.tiles.openPlanning')}
        />
        <KpiTile
          label={t('studio.dashboard.tiles.weekFill')}
          value={
            summary === null
              ? null
              : summary.week.percent === null
                ? t('studio.dashboard.tiles.noData')
                : number.format(summary.week.percent)
          }
          {...(summary?.week.percent === null ? {} : { unit: '%' })}
          delta={
            deltas === null || deltas.week.percent === null || deltas.previousWeek.percent === null
              ? null
              : {
                  text: signed(
                    deltas.week.percent - deltas.previousWeek.percent,
                    t('studio.dashboard.tiles.points'),
                    locale,
                  ),
                  direction: direction(deltas.week.percent - deltas.previousWeek.percent),
                  context: t('studio.dashboard.tiles.vsPreviousWeek'),
                }
          }
          trend={summary?.fillTrend ?? null}
          failed={classesFailed}
          href="/dashboard/classes"
          linkLabel={t('studio.dashboard.tiles.openPlanning')}
        />
        <KpiTile
          label={t('studio.dashboard.tiles.members')}
          value={
            members.kind !== 'ready'
              ? null
              : members.value.complete
                ? number.format(members.value.items.length)
                : t('studio.dashboard.tiles.membersCapped', {
                    count: number.format(members.value.items.length),
                  })
          }
          delta={
            newThisWeek === null
              ? null
              : {
                  text: signed(newThisWeek, '', locale),
                  direction: direction(newThisWeek),
                  context: t('studio.dashboard.tiles.thisWeek'),
                }
          }
          trend={memberTrend}
          failed={members.kind === 'error' ? loadError : null}
          href="/dashboard/members"
          linkLabel={t('studio.dashboard.tiles.seeMembers')}
        />

        <section
          aria-labelledby="dashboard-today"
          className={cn(CARD, 'md:col-span-2 lg:col-span-8')}
        >
          <CardHeader
            id="dashboard-today"
            title={t('studio.dashboard.today.title')}
            detail={
              summary === null
                ? null
                : t(
                    pluralKey(locale, summary.today.length, {
                      one: 'studio.dashboard.today.countOne',
                      other: 'studio.dashboard.today.countOther',
                    }),
                    { count: summary.today.length },
                  )
            }
            action={
              <CardLink
                href="/dashboard/classes"
                label={t('studio.dashboard.tiles.openPlanning')}
              />
            }
          />
          {classesFailed !== null ? (
            <CardMessage text={loadError} />
          ) : summary === null || now === null ? (
            <RowsSkeleton rows={4} />
          ) : summary.today.length === 0 ? (
            <CardMessage text={t('studio.dashboard.today.empty')} />
          ) : (
            <>
              <TodayTimeline
                classes={summary.today}
                next={summary.next}
                now={now}
                locale={locale}
                t={t}
              />
              <p className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
                <span className="inline-block first-letter:uppercase">{nextLine}</span>
                <span className="tabular-nums">
                  {(() => {
                    const total = summary.today.reduce(
                      (sum, c) => sum + Math.max(0, c.capacity - c.remaining),
                      0,
                    );
                    return t(
                      pluralKey(locale, total, {
                        one: 'studio.dashboard.today.totalOne',
                        other: 'studio.dashboard.today.totalOther',
                      }),
                      { count: total },
                    );
                  })()}
                </span>
              </p>
            </>
          )}
        </section>

        <section
          aria-labelledby="dashboard-bookings"
          className={cn(CARD, 'md:col-span-2 lg:col-span-4')}
        >
          <CardHeader
            id="dashboard-bookings"
            title={t('studio.dashboard.bookings.title')}
            detail={
              summary === null
                ? null
                : t('studio.dashboard.bookings.total', {
                    count: number.format(summary.week.booked),
                  })
            }
          />
          {classesFailed !== null ? (
            <CardMessage text={loadError} />
          ) : summary === null || weekStart === null ? (
            <RowsSkeleton rows={4} />
          ) : summary.week.classes === 0 ? (
            <CardMessage text={t('studio.dashboard.bookings.empty')} />
          ) : (
            <BookingsChart
              values={summary.bookingsByDay}
              weekStart={weekStart}
              todayIndex={todayIndex}
              locale={locale}
              t={t}
            />
          )}
        </section>

        <section
          aria-labelledby="dashboard-upcoming"
          className={cn(CARD, 'md:col-span-2 lg:col-span-8')}
        >
          <CardHeader
            id="dashboard-upcoming"
            title={t('studio.dashboard.upcoming.title')}
            detail={t('studio.dashboard.upcoming.window')}
          />
          {classesFailed !== null ? (
            <CardMessage text={loadError} />
          ) : summary === null ? (
            <RowsSkeleton rows={5} />
          ) : summary.upcoming.length === 0 ? (
            <CardMessage text={t('studio.dashboard.upcoming.empty')} />
          ) : (
            <UpcomingTable classes={summary.upcoming} locale={locale} t={t} />
          )}
        </section>

        <OccupancyCard
          classes={classes.kind === 'ready' ? classes.value : null}
          failed={classes.kind === 'error'}
          now={now}
          locale={locale}
          t={t}
        />

        <nav
          aria-labelledby="dashboard-sections"
          className={cn(CARD, 'md:col-span-2 lg:col-span-8')}
        >
          <CardHeader id="dashboard-sections" title={t('studio.dashboard.sections.title')} />
          <ul className="divide-y divide-border">
            {SECTIONS.map((section) => {
              const SectionIcon = section.icon;
              return (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    className="grid grid-cols-[1.25rem_1fr_1rem] items-center gap-3 px-4 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[1.25rem_11rem_1fr_1rem]"
                  >
                    <SectionIcon aria-hidden="true" className="size-[18px] text-muted-foreground" />
                    <span className="text-sm font-medium">{t(section.titleKey)}</span>
                    <span className="hidden truncate text-sm text-muted-foreground sm:block">
                      {t(section.bodyKey)}
                    </span>
                    <CaretRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <ActivityCard activity={activity} now={now} t={t} locale={locale} />
      </div>
    </div>
  );
}

function ActivityCard({
  activity,
  now,
  t,
  locale,
}: {
  readonly activity: Load<ReadonlyArray<AuditItem>>;
  readonly now: Date | null;
  readonly t: Translator;
  readonly locale: 'fr' | 'en';
}): ReactElement {
  return (
    <section
      aria-labelledby="dashboard-activity"
      className={cn(CARD, 'md:col-span-2 lg:col-span-4')}
    >
      <CardHeader
        id="dashboard-activity"
        title={t('studio.dashboard.activity.title')}
        action={<CardLink href="/dashboard/audit" label={t('studio.dashboard.activity.link')} />}
      />
      {activity.kind === 'error' ? (
        <CardMessage text={t('studio.dashboard.loadError')} />
      ) : activity.kind === 'loading' || now === null ? (
        <RowsSkeleton rows={5} />
      ) : activity.value.length === 0 ? (
        <CardMessage text={t('studio.dashboard.activity.empty')} />
      ) : (
        <ul className="divide-y divide-border">
          {activity.value.map((item) => {
            const label = actionLabel(item.action, t);
            return (
              <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn('truncate text-sm', label === null ? 'font-mono' : 'font-medium')}
                  >
                    {label ?? item.action}
                  </span>
                  {label === null ? null : (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {item.action}
                    </span>
                  )}
                </span>
                <time
                  dateTime={item.createdAt}
                  title={formatEventDate(item.createdAt, locale)}
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                >
                  {formatEventTime(item.createdAt, now, locale)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
