'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
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
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

interface AuditItem {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

interface AuditPage {
  readonly items: ReadonlyArray<AuditItem>;
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 20;

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

export function AuditLogList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [items, setItems] = useState<ReadonlyArray<AuditItem>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  const fetchPage = useCallback(
    async (currentCursor: string | null) => {
      setStatus({ kind: 'loading' });
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        if (currentCursor !== null) params.set('cursor', currentCursor);
        const page = await client.get<AuditPage>(`/v1/audit?${params.toString()}`);
        setItems((prev) => (currentCursor === null ? [...page.items] : [...prev, ...page.items]));
        setCursor(page.nextCursor);
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

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );

  return (
    <div className="flex flex-col gap-4">
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}

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

          {items.map((item) => (
            <AuditRow key={item.id} item={item} fmt={fmt} />
          ))}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('studio.audit.count', { n: items.length })}
        </p>
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            disabled={status.kind === 'loading'}
            onClick={() => {
              void fetchPage(cursor);
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
  readonly fmt: Intl.DateTimeFormat;
}

function AuditRow({ item, fmt }: AuditRowProps): ReactElement {
  const actorDisplay = item.actorId !== null ? item.actorId.slice(0, 8) + '…' : '—';
  const targetDisplay =
    item.targetType !== null && item.targetId !== null
      ? `${item.targetType}:${item.targetId.slice(0, 8)}`
      : '—';

  return (
    <TableRow>
      <TableCell className="font-mono text-sm">{item.action}</TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
        {actorDisplay}
      </TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
        {targetDisplay}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <time dateTime={item.createdAt}>{fmt.format(new Date(item.createdAt))}</time>
      </TableCell>
    </TableRow>
  );
}
