'use client';

/**
 * `/dashboard` overview: four summary tiles, then today's classes, the
 * next ones, the latest admin actions and compact links to every section.
 *
 * Everything is read from endpoints the console already uses:
 * `GET /v1/classes` (this week and the next), `GET /v1/members` (walked
 * for the count) and `GET /v1/audit`. Each card loads and fails on its
 * own, and shows a skeleton of its final size while it loads.
 */
import {
  ArrowRightIcon,
  BookOpenIcon,
  CalendarBlankIcon,
  CaretRightIcon,
  CreditCardIcon,
  ListBulletsIcon,
  PaletteIcon,
  ScanIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useApiClient } from '../../lib/api/buildClient';
import { fetchMemberDirectory } from '../../lib/api/members';
import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../lib/i18n/t';
import { useNowMinute } from '../../lib/use-now-minute';

import {
  actionLabel,
  formatEventDate,
  formatEventTime,
  type AuditItem,
} from './audit/audit-format';
import {
  bookedSeats,
  classTiming,
  overviewRange,
  summarize,
  type OverviewClass,
} from './dashboard-summary';

import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error' };

const ACTIVITY_LIMIT = 5;

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

const CARD = 'flex flex-col rounded-lg border border-border bg-card text-card-foreground';
const LINK =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function DashboardOverview(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const nowMinute = useNowMinute();
  const now = useMemo(
    () => (nowMinute === null ? null : new Date(nowMinute * 60_000)),
    [nowMinute],
  );
  const [classes, setClasses] = useState<Load<ReadonlyArray<OverviewClass>>>({ kind: 'loading' });
  const [members, setMembers] = useState<Load<{ count: number; complete: boolean }>>({
    kind: 'loading',
  });
  const [activity, setActivity] = useState<Load<ReadonlyArray<AuditItem>>>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const { from, to } = overviewRange(new Date());
    const range = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });

    void client
      .get<{ items: ReadonlyArray<OverviewClass> }>(`/v1/classes?${range.toString()}`)
      .then(
        (res) => !cancelled && setClasses({ kind: 'ready', value: res.items }),
        () => !cancelled && setClasses({ kind: 'error' }),
      );
    void fetchMemberDirectory(client).then(
      (dir) =>
        !cancelled &&
        setMembers({ kind: 'ready', value: { count: dir.items.length, complete: dir.complete } }),
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
  const percent = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
    [locale],
  );

  const classesFailed = classes.kind === 'error';
  const membersValue =
    members.kind === 'ready'
      ? members.value.complete
        ? number.format(members.value.count)
        : t('studio.dashboard.tiles.membersCapped', { count: number.format(members.value.count) })
      : null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12">
      <Tile
        label={t('studio.dashboard.tiles.todayClasses')}
        value={summary === null ? null : number.format(summary.today.length)}
        failed={classesFailed}
        href="/dashboard/classes"
        linkLabel={t('studio.dashboard.tiles.openPlanning')}
        t={t}
      />
      <Tile
        label={t('studio.dashboard.tiles.weekBookings')}
        value={summary === null ? null : number.format(summary.week.booked)}
        failed={classesFailed}
        href="/dashboard/classes"
        linkLabel={t('studio.dashboard.tiles.openPlanning')}
        t={t}
      />
      <Tile
        label={t('studio.dashboard.tiles.weekFill')}
        value={
          summary === null
            ? null
            : summary.week.percent === null
              ? t('studio.dashboard.tiles.noData')
              : percent.format(summary.week.percent / 100)
        }
        failed={classesFailed}
        href="/dashboard/classes"
        linkLabel={t('studio.dashboard.tiles.openPlanning')}
        t={t}
      />
      <Tile
        label={t('studio.dashboard.tiles.members')}
        value={membersValue}
        failed={members.kind === 'error'}
        href="/dashboard/members"
        linkLabel={t('studio.dashboard.tiles.seeMembers')}
        t={t}
      />

      <section
        aria-labelledby="dashboard-today"
        className={cn(CARD, 'md:col-span-2 lg:col-span-6')}
      >
        <CardHeading
          id="dashboard-today"
          title={t('studio.dashboard.today.title')}
          detail={
            now === null
              ? null
              : new Intl.DateTimeFormat(locale, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(now)
          }
          href="/dashboard/classes"
          linkLabel={t('studio.dashboard.tiles.openPlanning')}
        />
        {classesFailed ? (
          <CardMessage text={t('studio.dashboard.loadError')} />
        ) : summary === null || now === null ? (
          <RowsSkeleton rows={4} />
        ) : summary.today.length === 0 ? (
          <CardMessage text={t('studio.dashboard.today.empty')} />
        ) : (
          <ul className="divide-y divide-border">
            {summary.today.map((cls) => (
              <ClassLine key={cls.id} cls={cls} now={now} locale={locale} t={t} showTiming />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="dashboard-upcoming"
        className={cn(CARD, 'md:col-span-2 lg:col-span-6')}
      >
        <CardHeading id="dashboard-upcoming" title={t('studio.dashboard.upcoming.title')} />
        {classesFailed ? (
          <CardMessage text={t('studio.dashboard.loadError')} />
        ) : summary === null || now === null ? (
          <RowsSkeleton rows={4} />
        ) : summary.upcoming.length === 0 ? (
          <CardMessage text={t('studio.dashboard.upcoming.empty')} />
        ) : (
          <ul className="divide-y divide-border">
            {summary.upcoming.map((cls) => (
              <ClassLine key={cls.id} cls={cls} now={now} locale={locale} t={t} showDay />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="dashboard-activity"
        className={cn(CARD, 'md:col-span-2 lg:col-span-6')}
      >
        <CardHeading
          id="dashboard-activity"
          title={t('studio.dashboard.activity.title')}
          href="/dashboard/audit"
          linkLabel={t('studio.dashboard.activity.link')}
        />
        {activity.kind === 'error' ? (
          <CardMessage text={t('studio.dashboard.loadError')} />
        ) : activity.kind === 'loading' || now === null ? (
          <RowsSkeleton rows={ACTIVITY_LIMIT} />
        ) : activity.value.length === 0 ? (
          <CardMessage text={t('studio.dashboard.activity.empty')} />
        ) : (
          <ul className="divide-y divide-border">
            {activity.value.map((item) => {
              const label = actionLabel(item.action, t);
              return (
                <li key={item.id} className="flex items-baseline justify-between gap-4 px-6 py-3">
                  {label === null ? (
                    <span className="min-w-0 truncate font-mono text-sm">{item.action}</span>
                  ) : (
                    <span className="min-w-0 truncate text-sm font-medium">{label}</span>
                  )}
                  <time
                    dateTime={item.createdAt}
                    title={formatEventDate(item.createdAt, locale)}
                    className="shrink-0 text-sm text-muted-foreground tabular-nums"
                  >
                    {formatEventTime(item.createdAt, now, locale)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <nav aria-labelledby="dashboard-sections" className={cn(CARD, 'md:col-span-2 lg:col-span-6')}>
        <CardHeading id="dashboard-sections" title={t('studio.dashboard.sections.title')} />
        <ul className="divide-y divide-border">
          {SECTIONS.map((section) => {
            const SectionIcon = section.icon;
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  className="group flex items-center gap-3 px-6 py-2.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <SectionIcon aria-hidden="true" className="size-[18px] shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{t(section.titleKey)}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t(section.bodyKey)}
                    </span>
                  </span>
                  <CaretRightIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

interface TileProps {
  readonly label: string;
  readonly value: string | null;
  readonly failed: boolean;
  readonly href: string;
  readonly linkLabel: string;
  readonly t: Translator;
}

function Tile({ label, value, failed, href, linkLabel, t }: TileProps): ReactElement {
  return (
    <section className={cn(CARD, 'justify-between gap-3 p-4 sm:p-6 lg:col-span-3')}>
      <h2 className="text-sm text-muted-foreground">{label}</h2>
      <div className="flex flex-col gap-2">
        {failed ? (
          <p className="text-sm text-destructive">{t('studio.dashboard.loadError')}</p>
        ) : value === null ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <p className="text-3xl font-semibold tabular-nums">{value}</p>
        )}
        <Link href={href} className={cn(LINK, 'self-start')}>
          {linkLabel}
          <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}

interface CardHeadingProps {
  readonly id: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly href?: string;
  readonly linkLabel?: string;
}

function CardHeading({ id, title, detail, href, linkLabel }: CardHeadingProps): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-6 py-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
        {detail === undefined || detail === null ? null : (
          <span className="ml-2 text-sm font-normal text-muted-foreground first-letter:uppercase">
            {detail}
          </span>
        )}
      </h2>
      {href === undefined || linkLabel === undefined ? null : (
        <Link href={href} className={LINK}>
          {linkLabel}
          <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

function CardMessage({ text }: { readonly text: string }): ReactElement {
  return <p className="px-6 py-6 text-sm text-muted-foreground">{text}</p>;
}

function RowsSkeleton({ rows }: { readonly rows: number }): ReactElement {
  return (
    <ul className="divide-y divide-border" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={`skeleton-${i}`} className="flex items-center gap-4 px-6 py-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12" />
        </li>
      ))}
    </ul>
  );
}

interface ClassLineProps {
  readonly cls: OverviewClass;
  readonly now: Date;
  readonly locale: Locale;
  readonly t: Translator;
  readonly showTiming?: boolean;
  readonly showDay?: boolean;
}

function ClassLine({ cls, now, locale, t, showTiming, showDay }: ClassLineProps): ReactElement {
  const start = new Date(cls.startsAt);
  const end = new Date(start.getTime() + cls.durationMin * 60_000);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
  const booked = bookedSeats(cls);
  const timing = classTiming(cls, now);

  return (
    <li
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-6 py-3',
        showTiming === true && timing === 'done' && 'text-muted-foreground',
      )}
    >
      <span className="w-28 text-sm tabular-nums">
        {showDay === true ? <span className="mr-2 font-medium">{day.format(start)}</span> : null}
        <time dateTime={cls.startsAt}>{time.format(start)}</time>
        {showDay === true ? null : (
          <span className="text-muted-foreground">
            {' - '}
            <time dateTime={end.toISOString()}>{time.format(end)}</time>
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{cls.title}</span>
        {showTiming === true && timing === 'live' ? (
          <span className="planning-pill-open shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
            {t('studio.dashboard.today.live')}
          </span>
        ) : null}
        {showTiming === true && timing === 'done' ? (
          <span className="hidden shrink-0 text-xs sm:inline">
            {t('studio.dashboard.today.done')}
          </span>
        ) : null}
      </span>
      <FillMeter booked={booked} capacity={cls.capacity} t={t} />
    </li>
  );
}

interface FillMeterProps {
  readonly booked: number;
  readonly capacity: number;
  readonly t: Translator;
}

/** Seats booked over capacity; the bar width is set from CSSOM (strict CSP, no style=""). */
function FillMeter({ booked, capacity, t }: FillMeterProps): ReactElement {
  const barRef = useRef<HTMLSpanElement | null>(null);
  const ratio = capacity === 0 ? 0 : Math.min(1, booked / capacity);
  useEffect(() => {
    barRef.current?.style.setProperty('--fill', `${String(ratio * 100)}%`);
  }, [ratio]);

  return (
    <span
      className="flex items-center gap-2"
      aria-label={t('studio.dashboard.today.fillLabel', { booked, capacity })}
      role="img"
    >
      <span
        aria-hidden="true"
        className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
      >
        <span ref={barRef} className="fill-meter-bar block h-full rounded-full bg-chart-1" />
      </span>
      <span aria-hidden="true" className="text-sm tabular-nums">
        {t('studio.dashboard.today.fill', { booked, capacity })}
      </span>
    </span>
  );
}
