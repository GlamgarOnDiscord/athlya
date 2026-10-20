'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useApiClient } from '../../../lib/api/buildClient';
import { fetchMemberDirectory, type StudioMember } from '../../../lib/api/members';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import {
  actionLabel,
  formatEventDate,
  formatEventTime,
  shortId,
  targetTypeLabel,
  type AuditItem,
} from './audit-format';

import type { Locale } from '@athlya/shared/i18n';

interface AuditPage {
  readonly items: ReadonlyArray<AuditItem>;
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 20;
const ALL_ACTIONS = '';

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

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
  const [actionFilter, setActionFilter] = useState<string>(ALL_ACTIONS);
  const [now, setNow] = useState<Date>(() => new Date());
  const filterId = useId();

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

  const actions = useMemo(
    () =>
      [...new Set(items.map((item) => item.action))]
        .map((code) => ({ code, label: actionLabel(code, t) ?? code }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [items, t, locale],
  );
  const visible = useMemo(
    () =>
      actionFilter === ALL_ACTIONS ? items : items.filter((item) => item.action === actionFilter),
    [items, actionFilter],
  );

  return (
    <div className="flex flex-col gap-4">
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={filterId} className="text-muted-foreground">
          {t('studio.audit.filter.label')}
        </Label>
        <select
          id={filterId}
          className="h-8 max-w-xs rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          <option value={ALL_ACTIONS}>{t('studio.audit.filter.all')}</option>
          {actions.map((action) => (
            <option key={action.code} value={action.code}>
              {action.label}
            </option>
          ))}
        </select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('studio.audit.actionLabel')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('studio.audit.actorLabel')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('studio.audit.targetLabel')}</TableHead>
            <TableHead>{t('studio.audit.timestampLabel')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {status.kind === 'loading' && items.length === 0
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                </TableRow>
              ))
            : null}

          {items.length === 0 && status.kind === 'idle' ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {t('studio.audit.empty')}
              </TableCell>
            </TableRow>
          ) : null}

          {items.length > 0 && visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {t('studio.audit.filter.noMatch')}
              </TableCell>
            </TableRow>
          ) : null}

          {visible.map((item) => (
            <AuditRow key={item.id} item={item} members={members} now={now} locale={locale} t={t} />
          ))}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t(
            pluralKey(locale, items.length, {
              one: 'studio.audit.countOne',
              other: 'studio.audit.countOther',
            }),
            { count: items.length },
          )}
        </p>
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
          </Button>
        ) : null}
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

  return (
    <TableRow>
      <TableCell>
        {label === null ? (
          <span className="font-mono text-sm">{item.action}</span>
        ) : (
          <div className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="font-mono text-xs text-muted-foreground">{item.action}</span>
          </div>
        )}
      </TableCell>
      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
        {item.actorId === null ? (
          t('studio.audit.system')
        ) : actor !== undefined ? (
          <div className="flex flex-col">
            <span className="text-foreground">{actor.displayName}</span>
            <span className="text-xs">{actor.email}</span>
          </div>
        ) : (
          <MonoId id={item.actorId} />
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
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
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        <time dateTime={item.createdAt} title={formatEventDate(item.createdAt, locale)}>
          {formatEventTime(item.createdAt, now, locale)}
        </time>
      </TableCell>
    </TableRow>
  );
}
