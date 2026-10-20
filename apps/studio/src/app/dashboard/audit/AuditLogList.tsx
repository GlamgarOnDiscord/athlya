'use client';

/**
 * `/dashboard/audit` client surface: the append-only audit log with human
 * labels, member names from the directory, category tabs, a text filter
 * and a CSV export, all over the events loaded so far (`GET /v1/audit`,
 * cursor pages of 20, newest first).
 */
import { CaretDownIcon, DownloadSimpleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { fetchMemberDirectory, type StudioMember } from '../../../lib/api/members';
import { useAuth } from '../../../lib/auth/AuthContext';
import { downloadCsv, toCsv } from '../../../lib/csv';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { matchesQuery } from '../../../lib/search-text';
import { initials } from '../members/members-view';

import {
  actionLabel,
  AUDIT_CATEGORIES,
  auditCategory,
  formatEventDate,
  formatEventTime,
  shortId,
  targetTypeLabel,
  type AuditCategory,
  type AuditItem,
} from './audit-format';

import type { Locale } from '@athlya/shared/i18n';

interface AuditPage {
  readonly items: ReadonlyArray<AuditItem>;
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 20;

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };
type CategoryTab = 'all' | AuditCategory;

export function AuditLogList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [items, setItems] = useState<ReadonlyArray<AuditItem>>([]);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [members, setMembers] = useState<ReadonlyMap<string, StudioMember>>(new Map());
  const [category, setCategory] = useState<CategoryTab>('all');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState<Date>(() => new Date());

  const fetchPage = useCallback(
    async (currentCursor: string | null) => {
      setStatus({ kind: 'loading' });
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        if (currentCursor !== null) params.set('cursor', currentCursor);
        const page = await client.get<AuditPage>(`/v1/audit?${params.toString()}`);
        setItems((prev) => (currentCursor === null ? [...page.items] : [...prev, ...page.items]));
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
        setNow(new Date());
        setStatus({ kind: 'idle' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', message });
      }
    },
    [client],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage]);

  // Names are a reading aid: when the directory cannot load, rows keep their short ids.
  useEffect(() => {
    let cancelled = false;
    void fetchMemberDirectory(client).then(
      (directory) => {
        if (!cancelled) setMembers(new Map(directory.items.map((m) => [m.id, m])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const nameOf = useCallback(
    (id: string | null): string | null =>
      id === null ? null : (members.get(id)?.displayName ?? null),
    [members],
  );

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (category === 'all' || auditCategory(item.action) === category) &&
          matchesQuery(
            query,
            item.action,
            actionLabel(item.action, t) ?? '',
            item.actorId ?? '',
            item.targetId ?? '',
            nameOf(item.actorId) ?? '',
            nameOf(item.targetId) ?? '',
          ),
      ),
    [items, category, query, t, nameOf],
  );

  const exportVisible = (): void => {
    downloadCsv(
      'journal-audit.csv',
      toCsv(
        [
          t('studio.audit.timestampLabel'),
          t('studio.audit.actionLabel'),
          t('studio.audit.actorLabel'),
          t('studio.audit.targetLabel'),
        ],
        visible.map((item) => [
          item.createdAt,
          item.action,
          item.actorId === null ? t('studio.audit.system') : (nameOf(item.actorId) ?? item.actorId),
          item.targetType === null ? '' : `${item.targetType}:${item.targetId ?? ''}`,
        ]),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.audit.title')}
        subtitle={t('studio.audit.subtitle')}
        actions={
          <Button
            variant="outline"
            size="lg"
            disabled={visible.length === 0}
            onClick={exportVisible}
          >
            <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
            {t('studio.audit.export')}
          </Button>
        }
      />

      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}

      <div className="flex flex-col rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-input px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring sm:w-80">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <input
              type="search"
              aria-label={t('studio.audit.search')}
              placeholder={t('studio.audit.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div
            role="group"
            aria-label={t('studio.audit.categories.label')}
            className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border p-0.5"
          >
            {(['all', ...AUDIT_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  category === c && 'bg-muted text-foreground',
                )}
              >
                {t(`studio.audit.categories.${c}`)}
              </button>
            ))}
          </div>
          <p className="ml-auto text-xs text-muted-foreground tabular-nums">
            {t(
              pluralKey(locale, items.length, {
                one: 'studio.audit.countOne',
                other: 'studio.audit.countOther',
              }),
              { count: items.length },
            )}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                  {t('studio.audit.actorLabel')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('studio.audit.actionLabel')}
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">
                  {t('studio.audit.targetLabel')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('studio.audit.timestampLabel')}
                </th>
              </tr>
            </thead>
            <tbody>
              {status.kind === 'loading' && items.length === 0
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={`skeleton-${String(i)}`} className="border-b border-border">
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <Skeleton className="h-4 w-32" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-48" />
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <Skeleton className="h-4 w-28" />
                      </td>
                      <td className="px-4 py-3">
                        <Skeleton className="h-4 w-32" />
                      </td>
                    </tr>
                  ))
                : null}

              {items.length === 0 && status.kind === 'idle' ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    {t('studio.audit.empty')}
                  </td>
                </tr>
              ) : null}

              {items.length > 0 && visible.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    {t('studio.audit.filter.noMatch')}
                  </td>
                </tr>
              ) : null}

              {visible.map((item) => (
                <AuditRow
                  key={item.id}
                  item={item}
                  members={members}
                  now={now}
                  locale={locale}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2">
          <p className="text-xs text-muted-foreground">{t('studio.audit.appendOnly')}</p>
          {hasMore ? (
            <Button
              variant="outline"
              size="sm"
              disabled={status.kind === 'loading'}
              onClick={() => {
                void fetchPage(cursorRef.current);
              }}
            >
              {status.kind === 'loading' ? t('common.loading') : t('studio.audit.loadMore')}
              <CaretDownIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface AuditRowProps {
  readonly item: AuditItem;
  readonly members: ReadonlyMap<string, StudioMember>;
  readonly now: Date;
  readonly locale: Locale;
  readonly t: Translator;
}

function MonoId({ id }: { readonly id: string }): ReactElement {
  return (
    <span className="font-mono text-xs" title={id}>
      {shortId(id)}
    </span>
  );
}

function AuditRow({ item, members, now, locale, t }: AuditRowProps): ReactElement {
  const label = actionLabel(item.action, t);
  const actor = item.actorId === null ? undefined : members.get(item.actorId);
  const targetMember =
    item.targetType === 'user' && item.targetId !== null ? members.get(item.targetId) : undefined;
  const actorName = item.actorId === null ? t('studio.audit.system') : (actor?.displayName ?? null);

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/50">
      <td className="hidden px-4 py-2.5 sm:table-cell">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-muted text-[0.6875rem] font-medium"
          >
            {initials(actorName ?? '?')}
          </span>
          {actorName !== null ? (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{actorName}</span>
              {actor === undefined ? null : (
                <span className="truncate text-xs text-muted-foreground">{actor.email}</span>
              )}
            </span>
          ) : (
            <MonoId id={item.actorId ?? ''} />
          )}
        </div>
      </td>
      <td className="px-4 py-2.5">
        {label === null ? (
          <span className="font-mono text-sm">{item.action}</span>
        ) : (
          <div className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="font-mono text-xs text-muted-foreground">{item.action}</span>
          </div>
        )}
      </td>
      <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
        {item.targetType === null ? null : (
          <div className="flex flex-col">
            <span className={targetMember === undefined ? undefined : 'text-foreground'}>
              {targetMember?.displayName ?? targetTypeLabel(item.targetType, t)}
            </span>
            {targetMember === undefined && item.targetId !== null ? (
              <MonoId id={item.targetId} />
            ) : null}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
        <time dateTime={item.createdAt} title={formatEventDate(item.createdAt, locale)}>
          {formatEventTime(item.createdAt, now, locale)}
        </time>
      </td>
    </tr>
  );
}
