'use client';

/**
 * `/dashboard/members` client surface: role tabs, search ("/" focuses it),
 * sortable columns, selection with a bulk bar and a per-row menu. Rows come
 * from `GET /v1/members` (cursor pages of 20); every count and export covers
 * the rows loaded so far, since the endpoint returns no total. A coach
 * (the API opens the list to that role too) gets the same directory
 * read only: no CSV export and no member file, which stay with
 * administrators (the API has no per-member read for coaches).
 */
import { can } from '@athlya/shared/roles';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  IdentificationCardIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { MemberAvatar } from '../../../components/MemberAvatar';
import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { downloadCsv, toCsv } from '../../../lib/csv';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { memberFileHref } from '../../../lib/links';

import {
  ROLE_TABS,
  roleCounts,
  visibleMembers,
  type MemberSort,
  type RoleTab,
} from './members-view';

import type { StudioMember } from '../../../lib/api/members';

interface MembersPage {
  readonly items: ReadonlyArray<StudioMember>;
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 20;

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

const ROLE_VARIANT: Record<StudioMember['role'], 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  manager: 'default',
  accueil: 'secondary',
  coach: 'secondary',
  member: 'outline',
};

const TAB_KEY = {
  all: 'studio.members.tabs.all',
  member: 'studio.members.tabs.member',
  coach: 'studio.members.tabs.coach',
  accueil: 'studio.members.tabs.accueil',
  manager: 'studio.members.tabs.manager',
  admin: 'studio.members.tabs.admin',
} as const;

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function MembersAdminList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const searchParams = useSearchParams();

  const { accessToken, user } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [items, setItems] = useState<ReadonlyArray<StudioMember>>([]);
  const cursorRef = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [query, setQuery] = useState<string>(() => searchParams.get('q') ?? '');
  const [tab, setTab] = useState<RoleTab>('all');
  const [sort, setSort] = useState<MemberSort>('joinedDesc');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const opensFiles = user !== null && can(user.role, 'members.file');
  const canExport = user !== null && can(user.role, 'members.file');

  const fetchPage = useCallback(
    async (currentCursor: string | null) => {
      setStatus({ kind: 'loading' });
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        if (currentCursor !== null) params.set('cursor', currentCursor);
        const page = await client.get<MembersPage>(`/v1/members?${params.toString()}`);
        setItems((prev) => (currentCursor === null ? [...page.items] : [...prev, ...page.items]));
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const counts = useMemo(() => roleCounts(items), [items]);
  const rows = useMemo(
    () => visibleMembers(items, tab, query, sort, locale),
    [items, tab, query, sort, locale],
  );
  const selectedRows = rows.filter((m) => selected.has(m.id));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const joinedFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale],
  );

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exportRows = (list: ReadonlyArray<StudioMember>, filename: string): void => {
    downloadCsv(
      filename,
      toCsv(
        [
          t('studio.members.columns.name'),
          t('studio.members.columns.email'),
          t('studio.members.columns.role'),
          t('studio.members.joinedAt'),
        ],
        list.map((m) => [
          m.displayName,
          m.email,
          t(`studio.members.role.${m.role}`),
          m.createdAt.slice(0, 10),
        ]),
      ),
    );
  };

  const copy = (text: string, done: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(done),
      () => toast.error(t('studio.members.copyFailed')),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.members.title')}
        subtitle={t(canExport ? 'studio.members.subtitle' : 'studio.members.readOnly')}
        {...(canExport
          ? {
              actions: (
                <Button
                  variant="outline"
                  size="lg"
                  disabled={rows.length === 0}
                  onClick={() => exportRows(rows, 'membres.csv')}
                >
                  <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
                  {t('studio.members.exportCsv')}
                </Button>
              ),
            }
          : {})}
      />

      <div
        role="group"
        aria-label={t('studio.members.tabs.label')}
        className="flex gap-6 overflow-x-auto border-b border-border"
      >
        {ROLE_TABS.map((role) => (
          <button
            key={role}
            type="button"
            aria-pressed={tab === role}
            onClick={() => {
              setTab(role);
              setSelected(new Set());
            }}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 border-transparent pb-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === role && 'border-foreground text-foreground',
            )}
          >
            {t(TAB_KEY[role])}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {counts[role]}
            </span>
          </button>
        ))}
      </div>

      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}

      <div className="flex flex-col rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
          <label className="flex h-8 w-full max-w-xs items-center gap-2 rounded-lg border border-input px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring sm:w-80">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              aria-label={t('studio.members.search')}
              aria-keyshortcuts="/"
              placeholder={t('studio.members.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd
              aria-hidden="true"
              className="rounded border border-border px-1 font-sans text-[0.6875rem] text-muted-foreground"
            >
              /
            </kbd>
          </label>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t(
              pluralKey(locale, items.length, {
                one: 'studio.members.countOne',
                other: 'studio.members.countOther',
              }),
              { count: items.length },
            )}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('studio.members.selectAll')}
                    checked={allSelected}
                    disabled={rows.length === 0}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((m) => m.id)))
                    }
                    className="size-4 accent-primary"
                  />
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 font-medium"
                  aria-sort={sort === 'name' ? 'ascending' : 'none'}
                >
                  <SortButton
                    label={t('studio.members.columns.name')}
                    active={sort === 'name'}
                    ascending
                    onClick={() => setSort('name')}
                  />
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                  {t('studio.members.columns.email')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('studio.members.columns.role')}
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 font-medium md:table-cell"
                  aria-sort={
                    sort === 'joinedDesc'
                      ? 'descending'
                      : sort === 'joinedAsc'
                        ? 'ascending'
                        : 'none'
                  }
                >
                  <SortButton
                    label={t('studio.members.joinedAt')}
                    active={sort !== 'name'}
                    ascending={sort === 'joinedAsc'}
                    onClick={() => setSort(sort === 'joinedDesc' ? 'joinedAsc' : 'joinedDesc')}
                  />
                </th>
                <th scope="col" className="w-12 px-3 py-2">
                  <span className="sr-only">{t('studio.members.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {status.kind === 'loading' && items.length === 0
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={`skeleton-${String(i)}`} className="border-b border-border">
                      <td className="px-3 py-3">
                        <Skeleton className="size-4" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <Skeleton className="size-8 rounded-full" />
                          <Skeleton className="h-4 w-32" />
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 sm:table-cell">
                        <Skeleton className="h-4 w-44" />
                      </td>
                      <td className="px-3 py-3">
                        <Skeleton className="h-5 w-16" />
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        <Skeleton className="h-4 w-24" />
                      </td>
                      <td />
                    </tr>
                  ))
                : null}

              {items.length === 0 && status.kind === 'idle' ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    {t('studio.members.empty')}
                  </td>
                </tr>
              ) : null}

              {items.length > 0 && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    {t('studio.members.noMatch')}
                  </td>
                </tr>
              ) : null}

              {rows.map((m) => (
                <tr
                  key={m.id}
                  className={cn(
                    'border-b border-border last:border-b-0 hover:bg-muted/50',
                    selected.has(m.id) && 'bg-muted/50',
                  )}
                >
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={t('studio.members.selectRow', { name: m.displayName })}
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      className="size-4 accent-primary"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <MemberAvatar displayName={m.displayName} avatarUrl={m.avatarUrl} />
                      {opensFiles ? (
                        <Link
                          href={memberFileHref(m.id)}
                          className="truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {m.displayName}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">{m.displayName}</span>
                      )}
                      {m.id === user?.id ? (
                        <Badge variant="secondary">{t('studio.members.you')}</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                    {m.email}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={ROLE_VARIANT[m.role]}>
                      {t(`studio.members.role.${m.role}`)}
                    </Badge>
                  </td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground tabular-nums md:table-cell">
                    <time dateTime={m.createdAt}>{joinedFmt.format(new Date(m.createdAt))}</time>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <RowMenu
                      member={m}
                      fileHref={opensFiles ? memberFileHref(m.id) : null}
                      t={t}
                      onCopy={() => copy(m.email, t('studio.members.emailCopied'))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2">
          {selectedRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <span className="pr-2 tabular-nums">
                {t(
                  pluralKey(locale, selectedRows.length, {
                    one: 'studio.members.selectedOne',
                    other: 'studio.members.selectedOther',
                  }),
                  { count: selectedRows.length },
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  copy(
                    selectedRows.map((m) => m.email).join(', '),
                    t('studio.members.emailsCopied'),
                  )
                }
              >
                <CopyIcon aria-hidden="true" data-icon="inline-start" />
                {t('studio.members.bulk.copyEmails')}
              </Button>
              {canExport ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => exportRows(selectedRows, 'membres-selection.csv')}
                >
                  <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
                  {t('studio.members.bulk.export')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t('studio.members.bulk.clear')}
              </Button>
            </div>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Button
              variant="outline"
              size="sm"
              disabled={status.kind === 'loading'}
              onClick={() => {
                void fetchPage(cursorRef.current);
              }}
            >
              {status.kind === 'loading' ? t('common.loading') : t('studio.members.loadMore')}
              <CaretDownIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SortButton({
  label,
  active,
  ascending,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly ascending: boolean;
  readonly onClick: () => void;
}): ReactElement {
  const Arrow = ascending ? ArrowUpIcon : ArrowDownIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
      {active ? <Arrow aria-hidden="true" className="size-3" /> : null}
    </button>
  );
}

function RowMenu({
  member,
  fileHref,
  t,
  onCopy,
}: {
  readonly member: StudioMember;
  /** The member file, for an admin; coaches have no per-member read. */
  readonly fileHref: string | null;
  readonly t: Translator;
  readonly onCopy: () => void;
}): ReactElement {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={t('studio.members.rowMenu', { name: member.displayName })}
        className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
      >
        <DotsThreeIcon aria-hidden="true" weight="bold" className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-44 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-sm outline-none">
            {fileHref === null ? null : (
              <Menu.LinkItem
                render={<Link href={fileHref} />}
                closeOnClick
                className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none data-highlighted:bg-muted"
              >
                <IdentificationCardIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                {t('studio.memberFile.open')}
              </Menu.LinkItem>
            )}
            <Menu.Item
              onClick={onCopy}
              className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none data-highlighted:bg-muted"
            >
              <CopyIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              {t('studio.members.copyEmail')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
