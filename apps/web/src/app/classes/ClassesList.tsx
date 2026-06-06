/**
 * Client umbrella for `/classes`.
 *
 * Responsibilities:
 *   - Fetch the member's upcoming classes via
 *     `GET /v1/classes?from=&to=` on mount. Range is "today 00:00
 *     UTC" to "today + 14 days 23:59 UTC", matching the API's
 *     90-day cap (Req 7.3) with plenty of headroom.
 *   - Render the four states: `loading`, `error` with retry,
 *     `empty`, and `ready` (grid of `<ClassCard>`s).
 *   - Handle booking via `POST /v1/reservations`, carrying a
 *     client-generated `Idempotency-Key` (Req 8.5, 20.3).
 *
 * Booking lifecycle:
 *   1. Click decrements `remaining` locally (optimistic).
 *   2. POST fires with a fresh `Idempotency-Key` per *logical*
 *      attempt. While the request is in-flight we keep the key in
 *      `keysInFlight` (keyed by `classId`); mid-flight retries
 *      reuse the same key, and we release the entry on resolve.
 *   3. Server outcomes:
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

import { Calendar as CalendarIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { type ApiClient } from '../../lib/api/client';
import { ApiError, ApiServerError } from '../../lib/api/client';
import { useApiClient } from '../../lib/api/use-api-client';
import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../lib/i18n/t';
import { newIdempotencyKey } from '../../lib/idempotency';

import { ClassCard, type ClassCardInfo } from './ClassCard';

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
function buildRange(now: Date): { from: string; to: string } {
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
  return { from: startOfDay.toISOString(), to: endOfLastDay.toISOString() };
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
    bookedClassIds: ReadonlySet<string>;
    errorByClassId: Readonly<Record<string, string>>;
  }

  const [{ status, reloadNonce, bookingInFlight, bookedClassIds, errorByClassId }, setState] =
    useState<ClassesListState>(() => ({
      status: { kind: 'loading' },
      reloadNonce: 0,
      bookingInFlight: new Set<string>(),
      bookedClassIds: new Set<string>(),
      errorByClassId: {},
    }));

  /**
   * `classId → in-flight Idempotency-Key`. A fresh key is generated
   * on the first click of a given card; while the POST is
   * outstanding any retry (shouldn't happen today because the CTA
   * is disabled, but the shape leaves room for it) reuses the same
   * key. The entry is released on resolve.
   */
  const keysInFlightRef = useRef<Map<string, string> | null>(null);
  if (keysInFlightRef.current === null) keysInFlightRef.current = new Map();

  /* --------------------------- fetch ------------------------------ */

  const prevFetchDepsRef = useRef({ client, reloadNonce, bootResolved });
  const depsChanged =
    prevFetchDepsRef.current.client !== client ||
    prevFetchDepsRef.current.reloadNonce !== reloadNonce ||
    prevFetchDepsRef.current.bootResolved !== bootResolved;

  if (depsChanged && bootResolved) {
    prevFetchDepsRef.current = { client, reloadNonce, bootResolved };
    setState((s) => ({ ...s, status: { kind: 'loading' } }));
  }

  useEffect(() => {
    if (!bootResolved) return;
    let cancelled = false;

    const { from, to } = buildRange(new Date());
    const qs = new URLSearchParams({ from, to }).toString();
    const path = `/v1/classes?${qs}`;

    void (async () => {
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
      if (!cancelled) setState((s) => ({ ...s, status: next }));
    })();

    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce, bootResolved]);

  /* --------------------------- helpers ---------------------------- */

  const retry = useCallback(() => {
    setState((s) => ({ ...s, reloadNonce: s.reloadNonce + 1 }));
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
    async (classId: string): Promise<void> => {
      // Pick / mint the Idempotency-Key for this logical attempt.
      let key = keysInFlightRef.current!.get(classId);
      if (key === undefined) {
        key = newIdempotencyKey();
        keysInFlightRef.current!.set(classId, key);
      }

      // Clear any stale per-card error before the new attempt.
      setCardError(classId, null);
      setState((s) => {
        if (s.bookingInFlight.has(classId)) return s;
        const next = new Set(s.bookingInFlight);
        next.add(classId);
        return { ...s, bookingInFlight: next };
      });

      // Optimistic decrement.
      mutateRemaining(classId, -1);

      try {
        const body = await client.post<BookingSuccessBody>(
          '/v1/reservations',
          { classId },
          { headers: { 'Idempotency-Key': key } },
        );

        if (body.status === 'waitlist') {
          toast.info(t('reservations.waitlistPosition', { position: body.position ?? 0 }));
        } else {
          toast.success(t('reservations.confirmed'));
        }
        setState((s) => {
          const next = new Set(s.bookedClassIds);
          next.add(classId);
          return { ...s, bookedClassIds: next };
        });
      } catch (err) {
        if (err instanceof ApiError) {
          // 409 idempotent replay — the seat is effectively
          // ours already; surface as a confirmation and
          // keep the optimistic decrement.
          if (err.status === 409) {
            toast.success(t('reservations.confirmed'));
            setState((s) => {
              const next = new Set(s.bookedClassIds);
              next.add(classId);
              return { ...s, bookedClassIds: next };
            });
          } else if (err.status === 422 && err.problem?.code === 'class_in_past') {
            mutateRemaining(classId, +1);
            setCardError(classId, t('errors.classInPast'));
          } else if (err.status === 422) {
            mutateRemaining(classId, +1);
            setCardError(classId, t('errors.bookingFull'));
          } else {
            mutateRemaining(classId, +1);
            setCardError(classId, t('errors.generic'));
          }
        } else if (err instanceof ApiServerError) {
          mutateRemaining(classId, +1);
          setCardError(classId, t('errors.generic'));
        } else {
          // Network / unknown.
          mutateRemaining(classId, +1);
          setCardError(classId, t('errors.generic'));
        }
      } finally {
        // Release the in-flight key regardless of outcome.
        keysInFlightRef.current!.delete(classId);
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

  /* --------------------------- render ----------------------------- */

  if (status.kind === 'loading') {
    return (
      <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3">
        {(['s1', 's2', 's3'] as const).map((id) => (
          <li key={id} aria-hidden="true">
            <Card>
              <CardHeader>
                <Skeleton className="h-5 w-48" />
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
              <CardFooter>
                <Skeleton className="h-9 w-24" />
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>
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
        <CalendarIcon className="size-12 text-muted-foreground" aria-hidden="true" />
        <p className="text-muted-foreground">{t('classes.list.empty')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-reload-key={reloadNonce}>
      <ul
        // `grid` / responsive breakpoints are a visual concern;
        // semantically the cards form a list.
        className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3"
      >
        {status.items.map((item) => (
          <li key={item.id}>
            <ClassCard
              classInfo={item}
              t={t}
              locale={locale}
              onBook={handleBook}
              booked={bookedClassIds.has(item.id)}
              disabled={bookingInFlight.has(item.id)}
              error={errorByClassId[item.id] ?? null}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
