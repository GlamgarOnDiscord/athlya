'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface MemberRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'member' | 'coach' | 'admin';
  readonly avatarUrl: string | null;
  readonly createdAt: string;
}

interface MembersPage {
  readonly items: ReadonlyArray<MemberRow>;
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 20;

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

export function MembersAdminList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [items, setItems] = useState<ReadonlyArray<MemberRow>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [query, setQuery] = useState<string>('');

  const fetchPage = useCallback(
    async (currentCursor: string | null) => {
      setStatus({ kind: 'loading' });
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        if (currentCursor !== null) params.set('cursor', currentCursor);
        const page = await client.get<MembersPage>(`/v1/members?${params.toString()}`);
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

  const filtered = useMemo(
    () =>
      query.trim() === ''
        ? items
        : items.filter(
            (m) =>
              m.displayName.toLowerCase().includes(query.toLowerCase()) ||
              m.email.toLowerCase().includes(query.toLowerCase()),
          ),
    [items, query],
  );

  return (
    <div className="flex flex-col gap-4">
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {status.message}
        </p>
      ) : null}

      <Input
        type="search"
        placeholder={t('studio.members.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-xs"
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('studio.members.title')}</TableHead>
            <TableHead className="hidden sm:table-cell">Email</TableHead>
            <TableHead>{t('studio.members.role.member')}</TableHead>
            <TableHead className="hidden md:table-cell">Inscrit le</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {status.kind === 'loading' && items.length === 0
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 rounded-full" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                </TableRow>
              ))
            : null}

          {items.length === 0 && status.kind === 'idle' ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {t('studio.members.empty')}
              </TableCell>
            </TableRow>
          ) : null}

          {filtered.map((m) => (
            <MemberRowItem key={m.id} member={m} locale={locale} t={t} />
          ))}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('studio.members.count', { n: items.length })}
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
            {status.kind === 'loading' ? t('common.loading') : t('studio.members.loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface MemberRowItemProps {
  readonly member: MemberRow;
  readonly locale: 'fr' | 'en';
  readonly t: ReturnType<typeof createTranslator>;
}

const ROLE_VARIANT: Record<MemberRow['role'], 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  coach: 'secondary',
  member: 'outline',
};

function MemberRowItem({ member, locale, t }: MemberRowItemProps): ReactElement {
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    [locale],
  );
  const joined = fmt.format(new Date(member.createdAt));

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          {member.avatarUrl !== null && member.avatarUrl !== '' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={member.avatarUrl}
              alt=""
              className="size-8 rounded-full border border-border object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full border border-border bg-muted text-xs text-muted-foreground"
            >
              {member.displayName.charAt(0).toUpperCase() || '?'}
            </div>
          )}
          <span className="font-medium">{member.displayName}</span>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
        {member.email}
      </TableCell>
      <TableCell>
        <Badge variant={ROLE_VARIANT[member.role]}>{t(`studio.members.role.${member.role}`)}</Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
        <time dateTime={member.createdAt}>{joined}</time>
      </TableCell>
    </TableRow>
  );
}
