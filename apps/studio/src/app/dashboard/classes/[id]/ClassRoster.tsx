'use client';

/**
 * A class with its roster (issue #746): who is booked, who waits for a seat
 * and who has been checked in, with a manual check-in for staff. Data comes
 * from `GET /v1/classes/:id/roster` (studio admin, or the coach of the
 * class) and a check-in posts to its `check-in` sub-route, which stamps the
 * same reservation column as the kiosk. Admins reach each member's file
 * from a name; coaches have no per-member read.
 */
import { can } from '@athlya/shared/roles';
import { ArrowLeftIcon, CheckIcon, ScanIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { MemberAvatar } from '../../../../components/MemberAvatar';
import { PageHeader } from '../../../../components/shell/PageHeader';
import { useApiClient } from '../../../../lib/api/buildClient';
import { failureCode, loadFailure, type LoadFailure } from '../../../../lib/api/load-failure';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../../lib/idempotency';
import { memberFileHref } from '../../../../lib/links';
import { useNowMinute } from '../../../../lib/use-now-minute';
import {
  CARD,
  CardHeader,
  CardMessage,
  FillMeter,
  LABEL,
  RowsSkeleton,
} from '../../overview/parts';

import { attendanceState, rosterStats, withEntry, type AttendanceState } from './roster-view';

import type { Locale } from '@athlya/shared/i18n';
import type { ClassRosterEntry, ClassRosterResponse } from '@athlya/shared/schemas/api';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly roster: ClassRosterResponse }
  | { readonly kind: 'failed'; readonly failure: LoadFailure };

/** Entered with a full document load, for its own camera policy (`next.config.ts`). */
const KIOSK_HREF = '/dashboard/checkin';

const FAILURE_KEY = {
  forbidden: 'studio.roster.forbidden',
  notFound: 'studio.roster.notFound',
  error: 'studio.roster.loadError',
} as const;

const CHECK_IN_ERROR_KEY = {
  already_checked_in: 'studio.checkin.errors.already_checked_in',
  outside_window: 'studio.checkin.errors.outside_window',
  checkin_limit_reached: 'studio.checkin.errors.checkin_limit_reached',
  rate_limited: 'studio.checkin.errors.checkin_limit_reached',
  not_confirmed: 'studio.roster.notConfirmed',
} as const;

function isKnownCode(code: string | undefined): code is keyof typeof CHECK_IN_ERROR_KEY {
  return code !== undefined && code in CHECK_IN_ERROR_KEY;
}

export function ClassRoster({ classId }: { readonly classId: string }): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken, user } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);
  const nowMinute = useNowMinute();
  const isPlanner = user !== null && can(user.role, 'classes.write');
  const opensFiles = user !== null && can(user.role, 'members.file');

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void client.get<ClassRosterResponse>(`/v1/classes/${encodeURIComponent(classId)}/roster`).then(
      (roster) => !cancelled && setLoad({ kind: 'ready', roster }),
      (err: unknown) => !cancelled && setLoad({ kind: 'failed', failure: loadFailure(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, classId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const checkIn = useCallback(
    async (entry: ClassRosterEntry) => {
      setPending((prev) => new Set(prev).add(entry.reservationId));
      try {
        const updated = await client.post<ClassRosterEntry>(
          `/v1/classes/${encodeURIComponent(classId)}/roster/${encodeURIComponent(entry.reservationId)}/check-in`,
          undefined,
          { headers: { 'Idempotency-Key': newIdempotencyKey() } },
        );
        setLoad((current) =>
          current.kind === 'ready'
            ? { kind: 'ready', roster: withEntry(current.roster, updated) }
            : current,
        );
        toast.success(t('studio.roster.checkedInToast', { name: entry.member.displayName }));
      } catch (err: unknown) {
        const code = failureCode(err);
        toast.error(
          t(isKnownCode(code) ? CHECK_IN_ERROR_KEY[code] : 'studio.checkin.errors.generic'),
        );
        // The row moved under us (stamped at the kiosk, cancelled): show what is true now.
        if (code === 'already_checked_in' || code === 'not_confirmed') reload();
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(entry.reservationId);
          return next;
        });
      }
    },
    [client, classId, reload, t],
  );

  const backHref = isPlanner ? '/dashboard/classes' : '/dashboard/planning';
  const back = (
    <Link
      href={backHref}
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      {t(
        isPlanner
          ? 'studio.nav.classes'
          : user?.role === 'coach'
            ? 'studio.nav.planning'
            : 'studio.nav.studioPlanning',
      )}
    </Link>
  );

  if (load.kind === 'failed') {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <section className={cn(CARD, 'items-start gap-3 p-6')}>
          <p role="alert" className="text-sm">
            {t(FAILURE_KEY[load.failure])}
          </p>
          {load.failure === 'error' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoad({ kind: 'loading' });
                reload();
              }}
            >
              {t('common.retry')}
            </Button>
          ) : null}
        </section>
      </div>
    );
  }

  const roster = load.kind === 'ready' ? load.roster : null;
  const now = nowMinute === null ? null : new Date(nowMinute * 60_000);
  const state = roster === null || now === null ? null : attendanceState(roster.attendance, now);

  return (
    <div className="flex flex-col gap-6">
      {back}
      <PageHeader
        title={roster === null ? <Skeleton className="h-9 w-64" /> : roster.class.title}
        subtitle={
          roster === null ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <When roster={roster} locale={locale} t={t} />
          )
        }
        actions={
          <a href={KIOSK_HREF} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            <ScanIcon aria-hidden="true" data-icon="inline-start" />
            {t('studio.dashboard.actions.openKiosk')}
          </a>
        }
      />

      <Stats roster={roster} t={t} />

      {roster === null || state === null ? null : (
        <WindowNote state={state} roster={roster} locale={locale} t={t} />
      )}

      <section aria-labelledby="roster-confirmed" className={CARD}>
        <CardHeader
          id="roster-confirmed"
          title={t('studio.roster.confirmed.title')}
          detail={
            roster === null
              ? null
              : `${String(roster.confirmed.length)}/${String(roster.class.capacity)}`
          }
        />
        {roster === null ? (
          <RowsSkeleton rows={4} />
        ) : roster.confirmed.length === 0 ? (
          <CardMessage text={t('studio.roster.confirmed.empty')} />
        ) : (
          <ul className="divide-y divide-border">
            {roster.confirmed.map((entry) => (
              <RosterRow
                key={entry.reservationId}
                entry={entry}
                linkToFile={opensFiles}
                locale={locale}
                t={t}
                aside={
                  <Attendance
                    entry={entry}
                    state={state}
                    busy={pending.has(entry.reservationId)}
                    locale={locale}
                    t={t}
                    onCheckIn={() => {
                      void checkIn(entry);
                    }}
                  />
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="roster-waitlist" className={CARD}>
        <CardHeader
          id="roster-waitlist"
          title={t('studio.roster.waitlist.title')}
          detail={roster === null ? null : String(roster.waitlist.length)}
        />
        {roster === null ? (
          <RowsSkeleton rows={2} />
        ) : roster.waitlist.length === 0 ? (
          <CardMessage text={t('studio.roster.waitlist.empty')} />
        ) : (
          <ol className="divide-y divide-border">
            {roster.waitlist.map((entry, index) => (
              <RosterRow
                key={entry.reservationId}
                entry={entry}
                position={index + 1}
                linkToFile={opensFiles}
                locale={locale}
                t={t}
                aside={null}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function When({
  roster,
  locale,
  t,
}: {
  readonly roster: ClassRosterResponse;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const start = new Date(roster.class.startsAt);
  const end = new Date(start.getTime() + roster.class.durationMin * 60_000);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const coach = roster.class.coach;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="tabular-nums first-letter:uppercase">
        {t('studio.coach.next.at', {
          day: day.format(start),
          start: time.format(start),
          end: time.format(end),
        })}
      </span>
      <span aria-hidden="true" className="hidden sm:inline">
        ·
      </span>
      <span>
        {coach === null
          ? t('studio.roster.noCoach')
          : t('studio.roster.coach', { name: coach.displayName })}
      </span>
    </span>
  );
}

function Stats({
  roster,
  t,
}: {
  readonly roster: ClassRosterResponse | null;
  readonly t: Translator;
}): ReactElement {
  const stats = roster === null ? null : rosterStats(roster);
  const tile = cn(CARD, 'gap-2 p-4');
  const value = 'text-2xl font-semibold tracking-tight tabular-nums';
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      <section className={cn(tile, 'col-span-2 sm:col-span-1')}>
        <h2 className={LABEL}>{t('studio.roster.stats.booked')}</h2>
        {stats === null || roster === null ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <FillMeter
            booked={stats.booked}
            capacity={roster.class.capacity}
            label={t('studio.dashboard.today.fillLabel', {
              booked: stats.booked,
              capacity: roster.class.capacity,
            })}
          />
        )}
      </section>
      <section className={tile}>
        <h2 className={LABEL}>{t('studio.roster.stats.checkedIn')}</h2>
        {stats === null ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className={value}>
            {stats.checkedIn}
            <span className="text-base font-normal text-muted-foreground">/{stats.booked}</span>
          </p>
        )}
      </section>
      <section className={tile}>
        <h2 className={LABEL}>{t('studio.roster.stats.waitlist')}</h2>
        {stats === null ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className={value}>{stats.waitlist}</p>
        )}
      </section>
    </div>
  );
}

function WindowNote({
  state,
  roster,
  locale,
  t,
}: {
  readonly state: AttendanceState;
  readonly roster: ClassRosterResponse;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const dateTime = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const text =
    state === 'before'
      ? t('studio.roster.window.before', { time: time.format(new Date(roster.attendance.opensAt)) })
      : state === 'closed'
        ? t('studio.roster.window.closed', {
            date: dateTime.format(new Date(roster.attendance.closesAt)),
          })
        : t('studio.roster.window.open');
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function RosterRow({
  entry,
  position,
  linkToFile,
  locale,
  t,
  aside,
}: {
  readonly entry: ClassRosterEntry;
  readonly position?: number;
  readonly linkToFile: boolean;
  readonly locale: Locale;
  readonly t: Translator;
  readonly aside: ReactElement | null;
}): ReactElement {
  const booked = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const { member } = entry;
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      {position === undefined ? null : (
        <span className="w-6 shrink-0 text-sm text-muted-foreground tabular-nums">
          <span className="sr-only">{t('studio.roster.columns.position')} </span>
          {position}
        </span>
      )}
      <MemberAvatar displayName={member.displayName} avatarUrl={member.avatarUrl} />
      <div className="flex min-w-0 flex-1 flex-col">
        {linkToFile ? (
          <Link
            href={memberFileHref(member.id)}
            aria-label={t('studio.memberFile.openFor', { name: member.displayName })}
            className="w-fit max-w-full truncate rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {member.displayName}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium">{member.displayName}</span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('studio.roster.columns.bookedAt')}{' '}
          <time dateTime={entry.bookedAt}>{booked.format(new Date(entry.bookedAt))}</time>
        </span>
      </div>
      {aside}
    </li>
  );
}

function Attendance({
  entry,
  state,
  busy,
  locale,
  t,
  onCheckIn,
}: {
  readonly entry: ClassRosterEntry;
  readonly state: AttendanceState | null;
  readonly busy: boolean;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onCheckIn: () => void;
}): ReactElement {
  if (entry.checkedInAt !== null) {
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    return (
      <span className="planning-pill-open inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums">
        <CheckIcon aria-hidden="true" weight="bold" className="size-3.5" />
        {t('studio.roster.checkedInAt', { time: time.format(new Date(entry.checkedInAt)) })}
      </span>
    );
  }
  if (state !== 'open') {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        {t('studio.roster.notCheckedIn')}
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      aria-label={t('studio.roster.checkInFor', { name: entry.member.displayName })}
      onClick={onCheckIn}
    >
      <CheckIcon aria-hidden="true" data-icon="inline-start" />
      {busy ? t('common.loading') : t('studio.roster.checkIn')}
    </Button>
  );
}
