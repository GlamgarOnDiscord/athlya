/**
 * Client umbrella for `/classes`.
 *
 * Responsibilities:
 *   - Fetch the member's upcoming classes via
 *     `GET /v1/classes?from=&to=` on mount. Range is "today 00:00
 *     UTC" to "today + 14 days 23:59 UTC", matching the API's
 *     90-day cap (Req 7.3) with plenty of headroom.
 *   - Fetch the member's own reservations over the same window
 *     (`GET /v1/reservations/me`) so a class already held shows as
 *     booked or on the waitlist. That read is best effort: when it
 *     fails, the list still renders and every class stays bookable.
 *   - Render the four states: `loading`, `error` with retry,
 *     `empty`, and `ready`: a week strip of seven days above the
 *     selected day's `<ClassCard>`s (docs/design/ui-direction.md,
 *     "Booking calendar").
 *   - Handle booking via `POST /v1/reservations`, carrying a
 *     client-generated `Idempotency-Key` (Req 8.5, 20.3).
 *
 * Booking lifecycle:
 *   1. Click decrements `remaining` locally (optimistic) when a seat
 *      is left; joining the waitlist of a full class leaves it at 0.
 *   2. POST fires with a fresh `Idempotency-Key` per *logical*
 *      attempt. While the request is in-flight we keep the key in
 *      `keysInFlight` (keyed by `classId`); mid-flight retries
 *      reuse the same key, and we release the entry on resolve.
 *   3. Server outcomes (each success is also announced in the
 *      list's polite live region, the toast being visual only):
 *        • 201 `{ status: 'confirmed' }` → keep decrement, flash
 *          the success banner.
 *        • 202 `{ status: 'waitlist', position }` → keep
 *          decrement, flash the waitlist-position banner.
 *        • 409 idempotent replay → same as 201.
 *        • 422 `class_in_past` → revert decrement, show
 *          classInPast error on the card.
 *        • 422 `bookingFull` (or implicit full) → revert, show the
 *          generic `bookingFull` error on the card.
 *        • network / 5xx → revert, show the generic error on the card.
 *
 * Test seam: `client` prop accepts a fake {@link ApiClient}. When
 * absent, we build one lazily from the public API origin + the
 * in-memory access token store.
 *
 * @see Requirements 7.1, 7.2, 8.1, 8.2, 20.3.
 */
'use client';

import { CalendarBlankIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { type ApiClient } from '../../lib/api/client';
import { ApiError, ApiServerError } from '../../lib/api/client';
import {
  bookingsByClass,
  fetchMyReservations,
  type MemberBooking,
} from '../../lib/api/reservations';
import { useApiClient } from '../../lib/api/use-api-client';
import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../lib/i18n/t';
import { newIdempotencyKey } from '../../lib/idempotency';

import { ClassCard, type ClassCardInfo } from './ClassCard';
import {
  groupByDay,
  initialSelection,
  localDayKey,
  nextDayWithClasses,
  weekDays,
  WEEKS_SHOWN,
} from './schedule';
import { dayTabId, WeekStrip } from './WeekStrip';

import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

/** Fetch window: today 00:00 UTC → today + 14 days 23:59 UTC. */
const WINDOW_DAYS = 14;

/** Successful booking body (201 or 202) returned by the API. */
interface BookingSuccessBody {
  readonly status: 'confirmed' | 'waitlist';
  readonly reservation: unknown;
  readonly position?: number;
}

type FetchStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: ReadonlyArray<ClassCardInfo> }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error' };

export interface ClassesListProps {
  /** Optional translator — derived from `useLocale()` when absent. */
  readonly t?: Translator;
  /** Test seam: inject a fake API client instead of the real one. */
  readonly client?: ApiClient;
}

/**
 * Build the `[from, to]` ISO range for the fetch query. Exposed as a
 * pure function so tests that stub `Date.now` can predict the output
 * without re-implementing the arithmetic.
 */
function buildRange(now: Date): { from: Date; to: Date } {
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const endOfLastDay = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + WINDOW_DAYS,
      23,
      59,
      59,
      999,
    ),
  );
  return { from: startOfDay, to: endOfLastDay };
}

/**
 * Narrow a `ClassWithRemaining` API item into the card's view model.
 * We keep the transform here (rather than inside the card) so the
 * card stays pure and never has to know the wire shape.
 */
function toCardInfo(item: ClassWithRemaining): ClassCardInfo {
  return {
    id: item.id,
    title: item.title,
    startsAt: item.startsAt,
    durationMin: item.durationMin,
    capacity: item.capacity,
    remaining: item.remaining,
  };
}

export function ClassesList({ t: tProp, client: clientProp }: ClassesListProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);

  const client = useApiClient(clientProp);
  const { bootResolved } = useAuth();

  interface ClassesListState {
    status: FetchStatus;
    reloadNonce: number;
    bookingInFlight: ReadonlySet<string>;
    /** `classId → the member's place`, from the API and this session's bookings. */
    bookings: ReadonlyMap<string, MemberBooking>;
    errorByClassId: Readonly<Record<string, string>>;
    /** Day picked in the week strip; `null` until the member picks one. */
    selection: { readonly weekOffset: number; readonly dayKey: string } | null;
    /** Last booking outcome, read out by the polite live region. */
    announcement: string;
  }

  const [
    { status, reloadNonce, bookingInFlight, bookings, errorByClassId, selection, announcement },
    setState,
  ] = useState<ClassesListState>(() => ({
    status: { kind: 'loading' },
    reloadNonce: 0,
    bookingInFlight: new Set<string>(),
    bookings: new Map<string, MemberBooking>(),
    errorByClassId: {},
    selection: null,
    announcement: '',
  }));

  /** Reference day of the week strip, fixed for the page's lifetime. */
  const [now] = useState(() => new Date());
  const panelId = useId();

  /**
   * `classId → in-flight Idempotency-Key`. A fresh key is generated
   * on the first click of a given card; while the POST is
   * outstanding any retry (shouldn't happen today because the CTA
   * is disabled, but the shape leaves room for it) reuses the same
   * key. The entry is released on resolve.
   */
  const keysInFlightRef = useRef(new Map<string, string>());

  /* --------------------------- fetch ------------------------------ */

  useEffect(() => {
    if (!bootResolved) return;
    let cancelled = false;

    const range = buildRange(new Date());
    const qs = new URLSearchParams({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    }).toString();
    const path = `/v1/classes?${qs}`;

    void (async () => {
      const held = fetchMyReservations(client, range).then(bookingsByClass, () => null);
      let next: FetchStatus;
      try {
        const response = await client.get<{
          readonly items: ReadonlyArray<ClassWithRemaining>;
        }>(path);
        next =
          response.items.length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', items: response.items.map(toCardInfo) };
      } catch {
        next = { kind: 'error' };
      }
      if (cancelled) return;
      // The schedule shows as soon as it arrives; held places follow.
      setState((s) => ({ ...s, status: next }));
      const known = await held;
      if (cancelled || known === null) return;
      setState((s) => {
        // This session's outcomes are newer than the read, so they win.
        const merged = new Map(known);
        for (const [classId, booking] of s.bookings) merged.set(classId, booking);
        return { ...s, bookings: merged };
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce, bootResolved]);

  /* --------------------------- helpers ---------------------------- */

  const retry = useCallback(() => {
    setState((s) => ({ ...s, status: { kind: 'loading' }, reloadNonce: s.reloadNonce + 1 }));
  }, []);

  /** Apply a pure `remaining` delta to the ready list, no-op otherwise. */
  const mutateRemaining = useCallback((classId: string, delta: number) => {
    setState((s) => {
      if (s.status.kind !== 'ready') return s;
      let touched = false;
      const nextItems = s.status.items.map((item) => {
        if (item.id !== classId) return item;
        touched = true;
        return {
          ...item,
          remaining: Math.max(0, item.remaining + delta),
        };
      });
      return touched ? { ...s, status: { kind: 'ready', items: nextItems } } : s;
    });
  }, []);

  const setCardError = useCallback((classId: string, message: string | null) => {
    setState((s) => {
      if (message === null) {
        if (s.errorByClassId[classId] === undefined) return s;
        const { [classId]: _omit, ...rest } = s.errorByClassId;
        void _omit;
        return { ...s, errorByClassId: rest };
      }
      if (s.errorByClassId[classId] === message) return s;
      return { ...s, errorByClassId: { ...s.errorByClassId, [classId]: message } };
    });
  }, []);

  /* --------------------------- booking ---------------------------- */

  const handleBook = useCallback(
    async (classId: string, remaining: number): Promise<void> => {
      // Pick / mint the Idempotency-Key for this logical attempt.
      let key = keysInFlightRef.current.get(classId);
      if (key === undefined) {
        key = newIdempotencyKey();
        keysInFlightRef.current.set(classId, key);
      }

      // Clear any stale per-card error before the new attempt, and the
      // previous announcement so the same outcome is read out again.
      setCardError(classId, null);
      setState((s) => {
        if (s.bookingInFlight.has(classId)) return s;
        const next = new Set(s.bookingInFlight);
        next.add(classId);
        return { ...s, bookingInFlight: next, announcement: '' };
      });

      // Optimistic decrement. A full class (joining the waitlist) has no
      // seat to take, so there is nothing to give back if the call fails.
      const decremented = remaining > 0;
      if (decremented) mutateRemaining(classId, -1);
      const revertDecrement = (): void => {
        if (decremented) mutateRemaining(classId, +1);
      };

      try {
        const body = await client.post<BookingSuccessBody>(
          '/v1/reservations',
          { classId },
          { headers: { 'Idempotency-Key': key } },
        );

        let booking: MemberBooking;
        let message: string;
        if (body.status === 'waitlist') {
          booking = { kind: 'waitlist', position: body.position };
          message = t('reservations.waitlistPosition', { position: body.position ?? 0 });
          toast.info(message);
        } else {
          booking = { kind: 'confirmed' };
          message = t('reservations.confirmed');
          toast.success(message);
        }
        setState((s) => {
          const next = new Map(s.bookings);
          next.set(classId, booking);
          return { ...s, bookings: next, announcement: message };
        });
      } catch (err) {
        if (err instanceof ApiError) {
          // 409 idempotent replay — the seat is effectively
          // ours already; surface as a confirmation and
          // keep the optimistic decrement.
          if (err.status === 409) {
            const message = t('reservations.confirmed');
            toast.success(message);
            setState((s) => {
              const next = new Map(s.bookings);
              next.set(classId, { kind: 'confirmed' });
              return { ...s, bookings: next, announcement: message };
            });
          } else if (err.status === 422 && err.problem?.code === 'class_in_past') {
            revertDecrement();
            setCardError(classId, t('errors.classInPast'));
          } else if (err.status === 422) {
            revertDecrement();
            setCardError(classId, t('errors.bookingFull'));
          } else {
            revertDecrement();
            setCardError(classId, t('errors.generic'));
          }
        } else if (err instanceof ApiServerError) {
          revertDecrement();
          setCardError(classId, t('errors.generic'));
        } else {
          // Network / unknown.
          revertDecrement();
          setCardError(classId, t('errors.generic'));
        }
      } finally {
        // Release the in-flight key regardless of outcome.
        keysInFlightRef.current.delete(classId);
        setState((s) => {
          if (!s.bookingInFlight.has(classId)) return s;
          const next = new Set(s.bookingInFlight);
          next.delete(classId);
          return { ...s, bookingInFlight: next };
        });
      }
    },
    [client, mutateRemaining, setCardError, t],
  );

  /* --------------------------- week strip ------------------------- */

  const groups = useMemo(
    () => (status.kind === 'ready' ? groupByDay(status.items) : new Map<string, ClassCardInfo[]>()),
    [status],
  );
  const counts = useMemo(
    () => new Map([...groups].map(([key, items]) => [key, items.length] as const)),
    [groups],
  );
  const current = selection ?? initialSelection(now, groups);
  const days = useMemo(() => weekDays(now, current.weekOffset), [now, current.weekOffset]);

  const selectDay = useCallback(
    (dayKey: string) => {
      setState((s) => ({
        ...s,
        selection: { weekOffset: s.selection?.weekOffset ?? current.weekOffset, dayKey },
      }));
    },
    [current.weekOffset],
  );

  const showWeek = useCallback(
    (weekOffset: number) => {
      const week = weekDays(now, weekOffset).map(localDayKey);
      const dayKey = week.find((key) => (groups.get(key)?.length ?? 0) > 0) ?? week[0] ?? '';
      setState((s) => ({ ...s, selection: { weekOffset, dayKey } }));
    },
    [now, groups],
  );

  /* --------------------------- render ----------------------------- */

  if (status.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6" aria-hidden="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-6 w-48" />
        <ul className="flex list-none flex-col gap-3 p-0">
          {(['s1', 's2', 's3'] as const).map((id) => (
            <li key={id}>
              <Skeleton className="h-36 w-full rounded-xl" />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="flex flex-col gap-2" role="alert" aria-live="polite">
        <p className="text-sm text-destructive">{t('errors.generic')}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={retry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (status.kind === 'empty') {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <CalendarBlankIcon className="size-12 text-muted-foreground" aria-hidden="true" />
        <p className="text-muted-foreground">{t('classes.list.empty')}</p>
      </div>
    );
  }

  const dayItems = groups.get(current.dayKey) ?? [];
  const selectedDay = days.find((day) => localDayKey(day) === current.dayKey) ?? now;
  const next = dayItems.length === 0 ? nextDayWithClasses(now, current.dayKey, groups) : null;

  return (
    <div className="flex flex-col gap-6" data-reload-key={reloadNonce}>
      <WeekStrip
        days={days}
        todayKey={localDayKey(now)}
        selectedKey={current.dayKey}
        counts={counts}
        panelId={panelId}
        locale={locale}
        t={t}
        onSelect={selectDay}
        onPreviousWeek={current.weekOffset > 0 ? () => showWeek(current.weekOffset - 1) : undefined}
        onNextWeek={
          current.weekOffset < WEEKS_SHOWN - 1 ? () => showWeek(current.weekOffset + 1) : undefined
        }
      />

      <section
        id={panelId}
        role="tabpanel"
        aria-labelledby={dayTabId(current.dayKey)}
        className="flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold first-letter:uppercase">
          {new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          }).format(selectedDay)}
        </h2>
        {dayItems.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
            <p className="text-muted-foreground">{t('classes.list.dayEmpty')}</p>
            {next !== null ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setState((s) => ({ ...s, selection: next }))}
              >
                {t('classes.list.nextDay')}
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="flex list-none flex-col gap-3 p-0">
            {dayItems.map((item) => (
              <li key={item.id}>
                <ClassCard
                  classInfo={item}
                  t={t}
                  locale={locale}
                  onBook={handleBook}
                  booking={bookings.get(item.id) ?? null}
                  disabled={bookingInFlight.has(item.id)}
                  error={errorByClassId[item.id] ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
