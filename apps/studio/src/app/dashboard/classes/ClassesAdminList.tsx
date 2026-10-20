'use client';

import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { fetchRooms, fetchStaff, roomNames } from '../../../lib/api/rooms';
import { useAuth } from '../../../lib/auth/AuthContext';
import { downloadCsv, toCsv } from '../../../lib/csv';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';
import { useNowMinute } from '../../../lib/use-now-minute';
import { FillMeter } from '../overview/parts';

import { inRoom, type SeriesScope } from './class-form';
import { ClassesPlanning } from './ClassesPlanning';
import { ClassFormDialog, type ClassFormMode } from './ClassFormDialog';
import { useIsWide, useTodayKey } from './planning-clock';
import {
  fromDayKey,
  hasStarted,
  listRange,
  resolveView,
  shiftAnchor,
  toDayKey,
  visibleRange,
  WIDE_VIEWS,
} from './planning-grid';
import { PlanningToolbar, type ToolbarView } from './PlanningToolbar';
import { RoomFilter } from './RoomFilter';

import type { StudioMember } from '../../../lib/api/members';
import type { ClassWithRemaining, Room } from '@athlya/shared/schemas/api';

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
  // `?new=1` (sidebar quick create, dashboard action) opens the create dialog once.
  const searchParams = useSearchParams();
  const router = useRouter();
  const createRequested = searchParams.get('new') === '1';

  interface AdminListState {
    view: ToolbarView;
    anchorKey: string | null;
    status: Status;
    refreshNonce: number;
    dialogMode: ClassFormMode | null;
    deleteTarget: ClassWithRemaining | null;
    deleteScope: SeriesScope;
    roomFilter: string | null;
  }

  const [state, setState] = useState<AdminListState>(() => ({
    view: 'week',
    anchorKey: null,
    status: { kind: 'loading' },
    refreshNonce: 0,
    dialogMode: createRequested ? { kind: 'create' } : null,
    deleteTarget: null,
    deleteScope: 'one',
    roomFilter: null,
  }));
  const [rooms, setRooms] = useState<ReadonlyArray<Room>>([]);
  const [staff, setStaff] = useState<ReadonlyArray<StudioMember>>([]);

  // Rooms and staff feed the pickers, the filter and the tiles; a failure
  // leaves them empty and the planning still works without names.
  useEffect(() => {
    let cancelled = false;
    void fetchRooms(client).then(
      (items) => !cancelled && setRooms(items),
      () => undefined,
    );
    void fetchStaff(client).then(
      (items) => !cancelled && setStaff(items),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  const names = useMemo(() => roomNames(rooms), [rooms]);

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, refreshNonce: s.refreshNonce + 1 }));
  }, []);

  const todayKey = useTodayKey();
  const nowMinute = useNowMinute();
  const anchorKey = state.anchorKey ?? todayKey;
  const anchor = useMemo(() => (anchorKey === null ? null : fromDayKey(anchorKey)), [anchorKey]);

  const wide = useIsWide();
  const view: ToolbarView = state.view === 'list' ? 'list' : resolveView(state.view, wide);
  const viewOptions: ReadonlyArray<ToolbarView> = wide ? [...WIDE_VIEWS, 'list'] : ['day', 'list'];

  const range = useMemo(() => {
    if (anchor === null) return null;
    const { from, to } = view === 'list' ? listRange(anchor) : visibleRange(view, anchor);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [view, anchor]);
  const rangeFrom = range?.from ?? null;
  const rangeTo = range?.to ?? null;

  useEffect(() => {
    if (rangeFrom === null || rangeTo === null) return;
    let cancelled = false;
    setState((s) => ({ ...s, status: { kind: 'loading' } }));
    const path = `/v1/classes?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;
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
  }, [client, rangeFrom, rangeTo, state.refreshNonce]);

  const step = useCallback(
    (direction: -1 | 1) => {
      if (anchor === null) return;
      const next = toDayKey(shiftAnchor(view === 'list' ? 'month' : view, anchor, direction));
      setState((s) => ({ ...s, anchorKey: next }));
    },
    [anchor, view],
  );

  const showDay = useCallback((day: Date) => {
    setState((s) => ({
      ...s,
      view: s.view === 'month' ? 'week' : s.view,
      anchorKey: toDayKey(day),
    }));
  }, []);

  const openCreateAt = useCallback((startsAt: Date) => {
    setState((s) => ({
      ...s,
      dialogMode: { kind: 'create', startsAt: startsAt.toISOString() },
    }));
  }, []);

  const openEdit = useCallback((cls: ClassWithRemaining) => {
    setState((s) => ({ ...s, dialogMode: { kind: 'edit', cls } }));
  }, []);

  const openDelete = useCallback((cls: ClassWithRemaining) => {
    setState((s) => ({ ...s, deleteTarget: cls, deleteScope: 'one' }));
  }, []);

  const shown = useMemo(
    () => (state.status.kind === 'ready' ? inRoom(state.status.items, state.roomFilter) : []),
    [state.status, state.roomFilter],
  );

  const onCloseDialog = useCallback(
    (committed: boolean) => {
      setState((s) => ({
        ...s,
        dialogMode: null,
        refreshNonce: committed ? s.refreshNonce + 1 : s.refreshNonce,
      }));
      if (createRequested) router.replace('/dashboard/classes', { scroll: false });
    },
    [createRequested, router],
  );

  const listSummary = useMemo(() => {
    if (state.status.kind !== 'ready') return null;
    const listed = shown;
    const seatsTotal = listed.reduce((sum, c) => sum + c.capacity, 0);
    const booked = listed.reduce((sum, c) => sum + Math.max(0, c.capacity - c.remaining), 0);
    return t('studio.classes.list.summary', {
      classes: listed.length,
      seats: seatsTotal,
      booked,
    });
  }, [state.status, shown, t]);

  const exportList = useCallback(() => {
    if (state.status.kind !== 'ready') return;
    downloadCsv(
      'cours.csv',
      toCsv(
        [
          t('studio.classes.fields.title'),
          t('studio.classes.fields.startsAt'),
          t('studio.classes.fields.durationMin'),
          t('studio.classes.fields.capacity'),
          t('studio.classes.list.remaining'),
          t('studio.classes.columns.room'),
        ],
        shown.map((c) => [
          c.title,
          c.startsAt,
          String(c.durationMin),
          String(c.capacity),
          String(c.remaining),
          c.roomId == null ? '' : (names.get(c.roomId) ?? ''),
        ]),
      ),
    );
  }, [state.status, shown, names, t]);

  const handleDelete = useCallback(async () => {
    const target = state.deleteTarget;
    if (target === null) return;
    if (target.seriesId != null && state.deleteScope === 'following') {
      setState((s) => ({ ...s, deleteTarget: null }));
      try {
        await client.del(
          `/v1/classes/series/${target.seriesId}?fromClassId=${encodeURIComponent(target.id)}`,
        );
      } finally {
        setState((s) => ({ ...s, refreshNonce: s.refreshNonce + 1 }));
      }
      return;
    }
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
  }, [client, state.deleteTarget, state.deleteScope]);

  return (
    <div className="flex flex-col gap-4" data-reload-key={state.refreshNonce}>
      <PlanningToolbar
        view={view}
        views={viewOptions}
        anchor={anchor}
        locale={locale}
        t={t}
        onViewChange={(option) => setState((s) => ({ ...s, view: option }))}
        onToday={() => setState((s) => ({ ...s, anchorKey: null }))}
        onStep={step}
      >
        <RoomFilter
          rooms={rooms}
          value={state.roomFilter}
          t={t}
          onChange={(roomFilter) => setState((s) => ({ ...s, roomFilter }))}
        />
        <Button
          className="ml-auto md:ml-0"
          onClick={() => setState((s) => ({ ...s, dialogMode: { kind: 'create' } }))}
        >
          {t('studio.classes.create')}
        </Button>
      </PlanningToolbar>

      {state.status.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.status.message}
        </p>
      ) : null}

      {view !== 'list' && view !== 'day' && state.status.kind === 'empty' ? (
        <p className="text-sm text-muted-foreground">{t('studio.classes.empty')}</p>
      ) : null}

      {view === 'list' ? null : anchor === null || todayKey === null ? (
        <Skeleton className="h-[32rem] w-full" />
      ) : (
        <ClassesPlanning
          view={view}
          anchor={anchor}
          todayKey={todayKey}
          items={shown}
          busy={state.status.kind === 'loading'}
          locale={locale}
          t={t}
          roomNames={names}
          onSelectClass={openEdit}
          onDeleteClass={openDelete}
          onCreateAt={openCreateAt}
          onShowDay={showDay}
        />
      )}

      {view === 'list' ? (
        <div className="flex flex-col rounded-lg border border-border bg-card">
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
            <p className="text-xs text-muted-foreground tabular-nums">
              {listSummary === null ? null : listSummary}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={state.status.kind !== 'ready'}
              onClick={exportList}
            >
              <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
              {t('studio.classes.list.export')}
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('studio.classes.title')}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t('studio.classes.columns.date')}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t('studio.classes.fields.durationMin')}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t('studio.classes.columns.room')}
                </TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t('studio.classes.fields.capacity')}
                </TableHead>
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
                      <TableCell className="hidden lg:table-cell">
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
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
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {t('studio.classes.empty')}
                  </TableCell>
                </TableRow>
              ) : null}

              {state.status.kind === 'ready'
                ? shown.map((cls) => (
                    <ClassRow
                      key={cls.id}
                      cls={cls}
                      room={cls.roomId == null ? null : (names.get(cls.roomId) ?? null)}
                      started={
                        nowMinute !== null && hasStarted(cls.startsAt, new Date(nowMinute * 60_000))
                      }
                      locale={locale}
                      t={t}
                      onEdit={() => openEdit(cls)}
                      onDelete={() => openDelete(cls)}
                    />
                  ))
                : null}
            </TableBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {t('studio.classes.list.deleteNote')}
          </p>
        </div>
      ) : null}

      {state.dialogMode !== null ? (
        <ClassFormDialog
          mode={state.dialogMode}
          client={client}
          rooms={rooms}
          staff={staff}
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
              {state.deleteTarget.seriesId != null
                ? t('studio.classes.deleteConfirm.seriesBody')
                : t('studio.classes.deleteConfirm.body')}
            </p>
            {state.deleteTarget.seriesId != null ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">
                  {t('studio.classes.series.scopeLegend')}
                </legend>
                {(['one', 'following'] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="delete-scope"
                      value={value}
                      checked={state.deleteScope === value}
                      onChange={() => setState((s) => ({ ...s, deleteScope: value }))}
                      className="size-4 accent-primary"
                    />
                    {t(
                      value === 'one'
                        ? 'studio.classes.series.scopeOne'
                        : 'studio.classes.series.scopeFollowing',
                    )}
                  </label>
                ))}
              </fieldset>
            ) : null}
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
  readonly room: string | null;
  /** A started class cannot be moved: the row offers no edit action. */
  readonly started: boolean;
  readonly locale: 'fr' | 'en';
  readonly t: ReturnType<typeof createTranslator>;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

function ClassRow({
  cls,
  room,
  started,
  locale,
  t,
  onEdit,
  onDelete,
}: ClassRowProps): ReactElement {
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
  const seats = t('studio.classes.row.capacity', {
    remaining: cls.remaining,
    capacity: cls.capacity,
  });

  return (
    <TableRow>
      <TableCell className="whitespace-normal sm:whitespace-nowrap">
        <span className="font-medium">{cls.title}</span>
        <span className="block text-xs text-muted-foreground sm:hidden">
          <time dateTime={cls.startsAt}>{formatted}</time>,{' '}
          <span className="whitespace-nowrap">{seats}</span>
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
        <time dateTime={cls.startsAt}>{formatted}</time>
      </TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
        {cls.durationMin}&nbsp;min
      </TableCell>
      <TableCell className="hidden lg:table-cell text-muted-foreground text-sm">{room}</TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
        <span className="flex items-center gap-3">
          <FillMeter
            booked={cls.capacity - cls.remaining}
            capacity={cls.capacity}
            label={t('studio.dashboard.today.fillLabel', {
              booked: cls.capacity - cls.remaining,
              capacity: cls.capacity,
            })}
          />
        </span>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          {started ? null : (
            <Button variant="outline" size="sm" onClick={onEdit}>
              {t('studio.classes.row.edit')}
            </Button>
          )}
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
