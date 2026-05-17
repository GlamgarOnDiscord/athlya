'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { createTranslator } from '../../../lib/i18n/t';

import { ClassFormDialog, type ClassFormMode } from './ClassFormDialog';

import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

const DEFAULT_LOOKAHEAD_DAYS = 30;

function dateInputToIso(value: string, endOfDay = false): string {
  return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`).toISOString();
}

function nDaysFromNowIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; items: ReadonlyArray<ClassWithRemaining> }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export function ClassesAdminList(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  interface AdminListState {
    from: string;
    to: string;
    status: Status;
    refreshNonce: number;
    dialogMode: ClassFormMode | null;
    deleteTarget: ClassWithRemaining | null;
  }

  const [state, setState] = useState<AdminListState>(() => ({
    from: todayStartIso(),
    to: nDaysFromNowIso(DEFAULT_LOOKAHEAD_DAYS),
    status: { kind: 'loading' },
    refreshNonce: 0,
    dialogMode: null,
    deleteTarget: null,
  }));

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, refreshNonce: s.refreshNonce + 1 }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, status: { kind: 'loading' } }));
    const path = `/v1/classes?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
    void (async () => {
      let next: Status;
      try {
        const response = await client.get<{ items: ReadonlyArray<ClassWithRemaining> }>(path);
        next =
          response.items.length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', items: response.items };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        next = { kind: 'error', message };
      }
      if (!cancelled) setState((s) => ({ ...s, status: next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [client, state.from, state.to, state.refreshNonce]);

  const onCloseDialog = useCallback((committed: boolean) => {
    setState((s) => ({
      ...s,
      dialogMode: null,
      refreshNonce: committed ? s.refreshNonce + 1 : s.refreshNonce,
    }));
  }, []);

  const handleDelete = useCallback(async () => {
    const target = state.deleteTarget;
    if (target === null) return;
    // Optimistic removal: remove immediately from local state, no re-fetch needed.
    setState((s) => ({
      ...s,
      deleteTarget: null,
      status:
        s.status.kind === 'ready'
          ? s.status.items.length === 1
            ? { kind: 'empty' }
            : { kind: 'ready', items: s.status.items.filter((c) => c.id !== target.id) }
          : s.status,
    }));
    try {
      await client.del(`/v1/classes/${target.id}`);
    } catch {
      // API failed: rollback by re-fetching the real list.
      setState((s) => ({ ...s, refreshNonce: s.refreshNonce + 1 }));
    }
  }, [client, state.deleteTarget]);

  return (
    <div className="flex flex-col gap-4" data-reload-key={state.refreshNonce}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="sr-only">
            {t('studio.classes.range.from')} / {t('studio.classes.range.to')}
          </legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="classes-range-from" className="text-muted-foreground">
              {t('studio.classes.range.from')}
            </Label>
            <Input
              id="classes-range-from"
              type="date"
              value={state.from.slice(0, 10)}
              onChange={(e) => setState((s) => ({ ...s, from: dateInputToIso(e.target.value) }))}
              className="w-36"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="classes-range-to" className="text-muted-foreground">
              {t('studio.classes.range.to')}
            </Label>
            <Input
              id="classes-range-to"
              type="date"
              value={state.to.slice(0, 10)}
              onChange={(e) =>
                setState((s) => ({ ...s, to: dateInputToIso(e.target.value, true) }))
              }
              className="w-36"
            />
          </div>
        </fieldset>
        <Button onClick={() => setState((s) => ({ ...s, dialogMode: { kind: 'create' } }))}>
          {t('studio.classes.create')}
        </Button>
      </div>

      {state.status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.status.message}
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('studio.classes.title')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('studio.classes.range.from')}</TableHead>
            <TableHead className="hidden md:table-cell">
              {t('studio.classes.fields.durationMin')}
            </TableHead>
            <TableHead>{t('studio.classes.fields.capacity')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.status.kind === 'loading'
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-14" />
                  </TableCell>
                </TableRow>
              ))
            : null}

          {state.status.kind === 'empty' ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {t('studio.classes.empty')}
              </TableCell>
            </TableRow>
          ) : null}

          {state.status.kind === 'ready'
            ? state.status.items.map((cls) => (
                <ClassRow
                  key={cls.id}
                  cls={cls}
                  locale={locale}
                  t={t}
                  onEdit={() => setState((s) => ({ ...s, dialogMode: { kind: 'edit', cls } }))}
                  onDelete={() => setState((s) => ({ ...s, deleteTarget: cls }))}
                />
              ))
            : null}
        </TableBody>
      </Table>

      {state.dialogMode !== null ? (
        <ClassFormDialog
          mode={state.dialogMode}
          client={client}
          onClose={onCloseDialog}
          onConflict={() => refresh()}
        />
      ) : null}

      {state.deleteTarget !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setState((s) => ({ ...s, deleteTarget: null }));
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('studio.classes.deleteConfirm.title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('studio.classes.deleteConfirm.body')}
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setState((s) => ({ ...s, deleteTarget: null }))}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  void handleDelete();
                }}
              >
                {t('studio.classes.deleteConfirm.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

interface ClassRowProps {
  readonly cls: ClassWithRemaining;
  readonly locale: 'fr' | 'en';
  readonly t: ReturnType<typeof createTranslator>;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

function ClassRow({ cls, locale, t, onEdit, onDelete }: ClassRowProps): ReactElement {
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );
  const formatted = fmt.format(new Date(cls.startsAt));

  return (
    <TableRow>
      <TableCell className="font-medium">{cls.title}</TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
        <time dateTime={cls.startsAt}>{formatted}</time>
      </TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
        {cls.durationMin}&nbsp;min
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {t('studio.classes.row.capacity', {
          remaining: cls.remaining,
          capacity: cls.capacity,
        })}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('studio.classes.row.edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            {t('studio.classes.row.delete')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
