'use client';

/**
 * Member file for studio admins (issue #746): profile and role, attendance
 * counts, the bookings to come, the latest past ones and the consents the
 * member gave. Read from `GET /v1/members/:id`, which only an admin may
 * call; each class links to its roster.
 */
import { ArrowLeftIcon, CopyIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { MemberAvatar } from '../../../../components/MemberAvatar';
import { PageHeader } from '../../../../components/shell/PageHeader';
import { useApiClient } from '../../../../lib/api/buildClient';
import { loadFailure, type LoadFailure } from '../../../../lib/api/load-failure';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../../lib/i18n/t';
import { classRosterHref } from '../../../../lib/links';
import { CARD, CardHeader, CardMessage, LABEL, RowsSkeleton } from '../../overview/parts';

import { pastOutcome, upcomingOutcome, type ReservationOutcome } from './member-file-view';

import type { Locale } from '@athlya/shared/i18n';
import type { MemberFileReservation, MemberFileResponse } from '@athlya/shared/schemas/api';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly file: MemberFileResponse }
  | { readonly kind: 'failed'; readonly failure: LoadFailure };

const FAILURE_KEY = {
  forbidden: 'studio.memberFile.forbidden',
  notFound: 'studio.memberFile.notFound',
  error: 'studio.memberFile.loadError',
} as const;

const CONSENTS = ['marketing', 'analytics', 'thirdParty'] as const;

/** Chip of a reservation outcome; volt only as a fill under ink text. */
const OUTCOME_CHIP: Record<ReservationOutcome, string> = {
  attended: 'planning-pill-open',
  confirmed: 'border border-border',
  waitlist: 'bg-muted text-foreground',
  missed: 'border border-border text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
  no_show: 'bg-destructive/10 text-destructive',
};

const OUTCOME_KEY = {
  attended: 'studio.memberFile.status.attended',
  confirmed: 'studio.memberFile.status.confirmed',
  waitlist: 'studio.memberFile.status.waitlist',
  missed: 'studio.memberFile.status.missed',
  cancelled: 'studio.memberFile.status.cancelled',
  no_show: 'studio.memberFile.status.no_show',
} as const;

export function MemberFile({ memberId }: { readonly memberId: string }): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void client.get<MemberFileResponse>(`/v1/members/${encodeURIComponent(memberId)}`).then(
      (file) => !cancelled && setLoad({ kind: 'ready', file }),
      (err: unknown) => !cancelled && setLoad({ kind: 'failed', failure: loadFailure(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, memberId, reloadKey]);

  const back = (
    <Link
      href="/dashboard/members"
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      {t('studio.nav.members')}
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
                setReloadKey((key) => key + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          ) : null}
        </section>
      </div>
    );
  }

  const file = load.kind === 'ready' ? load.file : null;
  const longDate = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const copyEmail = (email: string): void => {
    void navigator.clipboard.writeText(email).then(
      () => toast.success(t('studio.members.emailCopied')),
      () => toast.error(t('studio.members.copyFailed')),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {back}
      <PageHeader
        title={
          file === null ? (
            <Skeleton className="h-9 w-64" />
          ) : (
            <span className="flex min-w-0 items-center gap-4">
              <MemberAvatar
                displayName={file.member.displayName}
                avatarUrl={file.member.avatarUrl}
                size="lg"
              />
              <span className="truncate">{file.member.displayName}</span>
            </span>
          )
        }
        subtitle={
          file === null ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge variant={file.member.role === 'member' ? 'outline' : 'secondary'}>
                {t(`studio.members.role.${file.member.role}`)}
              </Badge>
              <span className="break-all">{file.member.email}</span>
              <span>
                {t('studio.memberFile.memberSince', {
                  date: longDate.format(new Date(file.member.createdAt)),
                })}
              </span>
            </span>
          )
        }
        {...(file === null
          ? {}
          : {
              actions: (
                <Button variant="outline" size="lg" onClick={() => copyEmail(file.member.email)}>
                  <CopyIcon aria-hidden="true" data-icon="inline-start" />
                  {t('studio.members.copyEmail')}
                </Button>
              ),
            })}
      />

      <Stats file={file} locale={locale} t={t} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section aria-labelledby="file-upcoming" className={cn(CARD, 'lg:col-span-7')}>
          <CardHeader
            id="file-upcoming"
            title={t('studio.memberFile.upcoming.title')}
            detail={file === null ? null : String(file.upcoming.length)}
          />
          {file === null ? (
            <RowsSkeleton rows={3} />
          ) : file.upcoming.length === 0 ? (
            <CardMessage text={t('studio.memberFile.upcoming.empty')} />
          ) : (
            <ReservationTable
              rows={file.upcoming}
              outcome={upcomingOutcome}
              locale={locale}
              t={t}
            />
          )}
        </section>

        <section aria-labelledby="file-consents" className={cn(CARD, 'lg:col-span-5')}>
          <CardHeader id="file-consents" title={t('studio.memberFile.consents.title')} />
          {file === null ? (
            <RowsSkeleton rows={3} />
          ) : (
            <Consents consents={file.member.consents} locale={locale} t={t} />
          )}
        </section>

        <section aria-labelledby="file-past" className={cn(CARD, 'lg:col-span-12')}>
          <CardHeader
            id="file-past"
            title={t('studio.memberFile.past.title')}
            detail={
              file === null || file.past.length === 0
                ? null
                : t('studio.memberFile.past.latest', { count: file.past.length })
            }
          />
          {file === null ? (
            <RowsSkeleton rows={4} />
          ) : file.past.length === 0 ? (
            <CardMessage text={t('studio.memberFile.past.empty')} />
          ) : (
            <ReservationTable rows={file.past} outcome={pastOutcome} locale={locale} t={t} />
          )}
        </section>
      </div>
    </div>
  );
}

function Stats({
  file,
  locale,
  t,
}: {
  readonly file: MemberFileResponse | null;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'short' });
  const stats = file?.stats ?? null;
  const tiles = [
    { key: 'checkIns', label: t('studio.memberFile.stats.checkIns'), value: stats?.checkIns },
    {
      key: 'lastCheckIn',
      label: t('studio.memberFile.stats.lastCheckIn'),
      value:
        stats === null
          ? undefined
          : stats.lastCheckInAt === null
            ? t('studio.memberFile.stats.never')
            : date.format(new Date(stats.lastCheckInAt)),
    },
    { key: 'noShows', label: t('studio.memberFile.stats.noShows'), value: stats?.noShows },
    {
      key: 'cancellations',
      label: t('studio.memberFile.stats.cancellations'),
      value: stats?.cancellations,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((tile) => (
        <section key={tile.key} className={cn(CARD, 'gap-2 p-4')}>
          <h2 className={LABEL}>{tile.label}</h2>
          {tile.value === undefined ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{tile.value}</p>
          )}
        </section>
      ))}
    </div>
  );
}

function ReservationTable({
  rows,
  outcome,
  locale,
  t,
}: {
  readonly rows: ReadonlyArray<MemberFileReservation>;
  readonly outcome: (reservation: MemberFileReservation) => ReservationOutcome;
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const head =
    'px-4 py-2 text-left text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cn(head, 'hidden sm:table-cell')}>
              {t('studio.memberFile.columns.date')}
            </th>
            <th scope="col" className={head}>
              {t('studio.memberFile.columns.class')}
            </th>
            <th scope="col" className={cn(head, 'text-right')}>
              {t('studio.memberFile.columns.status')}
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((reservation) => {
            const start = new Date(reservation.class.startsAt);
            const result = outcome(reservation);
            return (
              <tr
                key={reservation.id}
                className="border-b border-border last:border-b-0 hover:bg-muted/50"
              >
                <td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground sm:table-cell">
                  <time dateTime={reservation.class.startsAt}>
                    <span className="first-letter:uppercase">{day.format(start)}</span>{' '}
                    <span className="text-foreground">{time.format(start)}</span>
                  </time>
                </td>
                <td className="max-w-56 px-4 py-2.5">
                  <Link
                    href={classRosterHref(reservation.class.id)}
                    className="block truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {reservation.class.title}
                  </Link>
                  <time
                    dateTime={reservation.class.startsAt}
                    className="block text-xs text-muted-foreground sm:hidden"
                  >
                    {day.format(start)} {time.format(start)}
                  </time>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span
                    className={cn(
                      'inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap',
                      OUTCOME_CHIP[result],
                    )}
                  >
                    {t(OUTCOME_KEY[result])}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Consents({
  consents,
  locale,
  t,
}: {
  readonly consents: MemberFileResponse['member']['consents'];
  readonly locale: Locale;
  readonly t: Translator;
}): ReactElement {
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="flex flex-1 flex-col">
      <dl className="divide-y divide-border text-sm">
        {CONSENTS.map((key) => (
          <div key={key} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt>{t(`consents.${key}`)}</dt>
            <dd
              className={cn(
                'font-medium',
                consents[key] ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(
                consents[key]
                  ? 'studio.memberFile.consents.granted'
                  : 'studio.memberFile.consents.refused',
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-auto border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        {t('consents.version')} {consents.version}, {t('consents.updatedAt').toLowerCase()}{' '}
        {date.format(new Date(consents.updatedAt))}
      </p>
    </div>
  );
}
