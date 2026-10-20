'use client';

/**
 * `/dashboard/planning`: the coach's schedule. The admin planning grid in
 * read-only mode (no create slot, no edit or delete menu), week or month on
 * a wide screen and a day agenda on a phone, with a switch between the
 * coach's own classes and the whole studio, and a room filter. Classes
 * come from `GET /v1/classes` and rooms from `GET /v1/classes/rooms`,
 * which every signed-in user may read.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { fetchRooms, roomNames } from '../../../lib/api/rooms';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';
import { inRoom } from '../classes/class-form';
import { ClassesPlanning } from '../classes/ClassesPlanning';
import { useIsWide, useTodayKey } from '../classes/planning-clock';
import {
  fromDayKey,
  resolveView,
  shiftAnchor,
  toDayKey,
  visibleRange,
  WIDE_VIEWS,
  type PlanningView,
} from '../classes/planning-grid';
import { PlanningToolbar, SegmentedControl } from '../classes/PlanningToolbar';
import { RoomFilter } from '../classes/RoomFilter';

import { scopeClasses, type ClassScope } from './coach-agenda';

import type { ClassWithRemaining, Room } from '@athlya/shared/schemas/api';

type Result =
  { kind: 'ready'; items: ReadonlyArray<ClassWithRemaining> } | { kind: 'error'; message: string };
type Status = { kind: 'loading' } | Result;

const SCOPES: ReadonlyArray<ClassScope> = ['mine', 'all'];

export function CoachPlanning(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken, user } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [view, setView] = useState<PlanningView>('week');
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [scope, setScope] = useState<ClassScope>('mine');
  const [loaded, setLoaded] = useState<{ range: string; result: Result } | null>(null);
  const [rooms, setRooms] = useState<ReadonlyArray<Room>>([]);
  const [roomFilter, setRoomFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRooms(client).then(
      (items) => !cancelled && setRooms(items),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  const names = useMemo(() => roomNames(rooms), [rooms]);

  const todayKey = useTodayKey();
  const wide = useIsWide();
  const shownView = resolveView(view, wide);
  const views: ReadonlyArray<PlanningView> = wide ? WIDE_VIEWS : ['day'];
  const currentKey = anchorKey ?? todayKey;
  const anchor = useMemo(() => (currentKey === null ? null : fromDayKey(currentKey)), [currentKey]);

  const range = useMemo(() => {
    if (anchor === null) return null;
    const { from, to } = visibleRange(shownView, anchor);
    return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString();
  }, [anchor, shownView]);

  useEffect(() => {
    if (range === null) return;
    let cancelled = false;
    void client.get<{ items: ReadonlyArray<ClassWithRemaining> }>(`/v1/classes?${range}`).then(
      (res) => !cancelled && setLoaded({ range, result: { kind: 'ready', items: res.items } }),
      (err: unknown) =>
        !cancelled &&
        setLoaded({
          range,
          result: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, range]);

  // Loading until the response for the period on show lands.
  const status = useMemo<Status>(
    () => (loaded === null || loaded.range !== range ? { kind: 'loading' } : loaded.result),
    [loaded, range],
  );

  const items = useMemo(
    () =>
      status.kind === 'ready' && user !== null
        ? inRoom(scopeClasses(status.items, scope, user.id), roomFilter)
        : [],
    [status, scope, user, roomFilter],
  );

  const step = useCallback(
    (direction: -1 | 1) => {
      if (anchor === null) return;
      setAnchorKey(toDayKey(shiftAnchor(shownView, anchor, direction)));
    },
    [anchor, shownView],
  );

  const showDay = useCallback((day: Date) => {
    setView((current) => (current === 'month' ? 'week' : current));
    setAnchorKey(toDayKey(day));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('studio.coach.planning.title')}
        subtitle={t('studio.coach.planning.subtitle')}
        actions={
          <SegmentedControl
            label={t('studio.coach.planning.scopeLabel')}
            options={SCOPES.map((value) => ({
              value,
              label: t(`studio.coach.planning.scope.${value}`),
            }))}
            value={scope}
            onChange={setScope}
          />
        }
      />

      <div className="flex flex-col gap-4">
        <PlanningToolbar
          view={shownView}
          views={views}
          anchor={anchor}
          locale={locale}
          t={t}
          onViewChange={setView}
          onToday={() => setAnchorKey(null)}
          onStep={step}
        >
          <RoomFilter rooms={rooms} value={roomFilter} t={t} onChange={setRoomFilter} />
        </PlanningToolbar>

        {status.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {status.message}
          </p>
        ) : null}

        {shownView !== 'day' && status.kind === 'ready' && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              scope === 'mine'
                ? 'studio.coach.planning.emptyMine'
                : 'studio.coach.planning.emptyAll',
            )}
          </p>
        ) : null}

        {anchor === null || todayKey === null ? (
          <Skeleton className="h-[32rem] w-full" />
        ) : (
          <ClassesPlanning
            view={shownView}
            anchor={anchor}
            todayKey={todayKey}
            items={items}
            busy={status.kind === 'loading'}
            locale={locale}
            t={t}
            roomNames={names}
            onShowDay={showDay}
          />
        )}
      </div>
    </div>
  );
}
