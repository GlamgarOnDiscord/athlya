'use client';

/**
 * `/dashboard/programs` client surface: list, status filter, editor and
 * archive (Epic 24, task 24.3).
 *
 * `ProgramsAdminList` binds the authenticated API client and the
 * locale; `ProgramsAdmin` takes them as props so tests drive it with a
 * fake client. Status changes are announced through a polite live
 * region.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

import { ProgramEditor, type ProgramEditorMode } from './ProgramEditor';

import type { ApiClient } from '../../../lib/api/client';
import type { Locale } from '@athlya/shared/i18n';
import type { ProgramDetail, ProgramStatus, ProgramSummary } from '@athlya/shared/schemas/api';

type Filter = 'all' | ProgramStatus;

type ListStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: ReadonlyArray<ProgramSummary> }
  | { readonly kind: 'error' };

const STATUS_VARIANT: Record<ProgramStatus, 'default' | 'secondary' | 'outline'> = {
  published: 'default',
  draft: 'secondary',
  archived: 'outline',
};

export interface ProgramsAdminProps {
  readonly client: ApiClient;
  readonly t: Translator;
  readonly locale: Locale;
}

export function ProgramsAdmin({ client, t, locale }: ProgramsAdminProps): ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  const [list, setList] = useState<ListStatus>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<ProgramEditorMode | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProgramSummary | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const filterId = useId();

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    [locale],
  );

  useEffect(() => {
    let cancelled = false;
    setList({ kind: 'loading' });
    const query = filter === 'all' ? '' : `?status=${filter}`;
    void client
      .get<{ items: ReadonlyArray<ProgramSummary> }>(`/v1/programs${query}`)
      .then(
        (response) => ({ kind: 'ready', items: response.items }) as const,
        () => ({ kind: 'error' }) as const,
      )
      .then((next) => {
        if (!cancelled) setList(next);
      });
    return () => {
      cancelled = true;
    };
  }, [client, filter, reload]);

  const openEditor = useCallback(
    async (program: ProgramSummary) => {
      setActionError(null);
      try {
        const detail = await client.get<ProgramDetail>(`/v1/programs/${program.id}`);
        setEditor({ kind: 'edit', program: detail });
      } catch {
        setActionError(t('studio.programs.editor.errors.loadFailed'));
      }
    },
    [client, t],
  );

  const closeEditor = useCallback(
    (committed: boolean) => {
      setEditor(null);
      if (committed) {
        setAnnouncement(t('studio.programs.saved'));
        setReload((n) => n + 1);
      }
    },
    [t],
  );

  const confirmArchive = useCallback(async () => {
    const target = archiveTarget;
    if (target === null) return;
    setArchiveTarget(null);
    setActionError(null);
    try {
      await client.post(`/v1/programs/${target.id}/archive`, undefined, {
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      });
      setAnnouncement(t('studio.programs.archived'));
    } catch {
      setActionError(t('studio.programs.editor.errors.generic'));
    }
    setReload((n) => n + 1);
  }, [archiveTarget, client, t]);

  if (editor !== null) {
    return (
      <>
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <ProgramEditor mode={editor} client={client} t={t} onDone={closeEditor} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={filterId} className="text-muted-foreground">
            {t('studio.programs.filter.label')}
          </Label>
          <select
            id={filterId}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="all">{t('studio.programs.filter.all')}</option>
            <option value="draft">{t('studio.programs.status.draft')}</option>
            <option value="published">{t('studio.programs.status.published')}</option>
            <option value="archived">{t('studio.programs.status.archived')}</option>
          </select>
        </div>
        <Button onClick={() => setEditor({ kind: 'create' })}>{t('studio.programs.create')}</Button>
      </div>

      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {list.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : null}

      <Table aria-busy={list.kind === 'loading'}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('studio.programs.columns.title')}</TableHead>
            <TableHead>{t('studio.programs.columns.status')}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t('studio.programs.columns.weeks')}
            </TableHead>
            <TableHead className="hidden md:table-cell">
              {t('studio.programs.columns.updated')}
            </TableHead>
            <TableHead>
              <span className="sr-only">{t('studio.programs.columns.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.kind === 'loading'
            ? Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={`skeleton-${String(i)}`}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-4 w-full" />
                    <span className="sr-only">{t('studio.programs.loading')}</span>
                  </TableCell>
                </TableRow>
              ))
            : null}

          {list.kind === 'ready' && list.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {t('studio.programs.empty')}
              </TableCell>
            </TableRow>
          ) : null}

          {list.kind === 'ready'
            ? list.items.map((program) => (
                <TableRow key={program.id}>
                  <TableCell className="font-medium">{program.title}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[program.status]}>
                      {t(`studio.programs.status.${program.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {program.weekCount}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    <time dateTime={program.updatedAt}>
                      {dateFormat.format(new Date(program.updatedAt))}
                    </time>
                  </TableCell>
                  <TableCell>
                    {program.status === 'archived' ? null : (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('studio.programs.row.editLabel', { title: program.title })}
                          onClick={() => {
                            void openEditor(program);
                          }}
                        >
                          {t('studio.programs.row.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={t('studio.programs.row.archiveLabel', {
                            title: program.title,
                          })}
                          onClick={() => setArchiveTarget(program)}
                        >
                          {t('studio.programs.row.archive')}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            : null}
        </TableBody>
      </Table>

      {archiveTarget !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiveTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('studio.programs.archiveConfirm.title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('studio.programs.archiveConfirm.body')}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setArchiveTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  void confirmArchive();
                }}
              >
                {t('studio.programs.archiveConfirm.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

export function ProgramsAdminList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);
  return <ProgramsAdmin client={client} t={t} locale={locale} />;
}
