/**
 * "My upcoming bookings" on `/me`: the member's confirmed and waitlisted
 * reservations whose class has not ended, soonest first
 * (`GET /v1/reservations/me`), each with its cancel action.
 *
 * Cancelling asks for a confirmation in the row, then sends
 * `DELETE /v1/reservations/{id}` with an `Idempotency-Key`. The action is
 * replaced by a note once the class is less than two hours away, the
 * window the API enforces (`cancellation_window_closed`); a refusal that
 * still comes back is shown on the row. Outcomes are read out by a
 * polite live region. A confirmed row also offers "Add to calendar",
 * whose event shares its UID with the member's calendar feed. With
 * nothing booked, the empty state offers one action: browse the classes.
 */
'use client';

import { CheckCircleIcon, HourglassMediumIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import { AddToCalendar } from '@/components/calendar/AddToCalendar';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { ApiError, type ApiClient } from '../../../lib/api/client';
import {
  canCancel,
  cancelReservationPath,
  fetchMyReservations,
  runningFrom,
  upcomingReservations,
  type MyReservation,
} from '../../../lib/api/reservations';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

export interface UpcomingBookingsProps {
  /** Optional translator, derived from `useLocale()` when absent. */
  readonly t?: Translator;
  /** Test seam: inject a fake API client instead of the real one. */
  readonly client?: ApiClient;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly MyReservation[] }
  | { readonly kind: 'error' };

function cancelButtonId(reservationId: string): string {
  return `booking-${reservationId}-cancel`;
}

function confirmButtonId(reservationId: string): string {
  return `booking-${reservationId}-confirm`;
}

function titleId(reservationId: string): string {
  return `booking-${reservationId}-title`;
}

export function UpcomingBookings({
  t: tProp,
  client: clientProp,
}: UpcomingBookingsProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);
  const client = useApiClient(clientProp);
  const headingId = useId();

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Readonly<Record<string, string>>>({});
  const [announcement, setAnnouncement] = useState('');
  /** Element to focus once the next render has committed. */
  const focusIdRef = useRef<string | null>(null);
  /** Clock the cancel window is read against, refreshed on each load. */
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const at = new Date();
      let next: LoadState;
      try {
        const items = await fetchMyReservations(client, { from: runningFrom(at) });
        next = { kind: 'ready', items: upcomingReservations(items, at) };
      } catch {
        next = { kind: 'error' };
      }
      if (cancelled) return;
      setNow(at);
      setLoad(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

  useEffect(() => {
    const id = focusIdRef.current;
    if (id === null) return;
    focusIdRef.current = null;
    document.getElementById(id)?.focus();
  });

  const retry = useCallback(() => {
    setLoad({ kind: 'loading' });
    setReloadNonce((n) => n + 1);
  }, []);

  const askConfirmation = useCallback((reservationId: string) => {
    setConfirmingId(reservationId);
    focusIdRef.current = confirmButtonId(reservationId);
  }, []);

  const keep = useCallback((reservationId: string) => {
    setConfirmingId(null);
    focusIdRef.current = cancelButtonId(reservationId);
  }, []);

  const cancel = useCallback(
    async (item: MyReservation): Promise<void> => {
      setConfirmingId(null);
      setCancellingId(item.id);
      setAnnouncement('');
      setErrorById((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)),
      );
      try {
        await client.del<unknown>(cancelReservationPath(item.id), {
          headers: { 'Idempotency-Key': newIdempotencyKey() },
        });
        const message = t('reservations.cancelled');
        toast.success(message);
        setAnnouncement(message);
        setLoad((current) =>
          current.kind === 'ready'
            ? { kind: 'ready', items: current.items.filter((row) => row.id !== item.id) }
            : current,
        );
        focusIdRef.current = headingId;
      } catch (err) {
        const windowClosed =
          err instanceof ApiError &&
          err.status === 422 &&
          err.problem?.code === 'cancellation_window_closed';
        const message = windowClosed ? t('reservations.cancelWindowClosed') : t('errors.generic');
        setErrorById((current) => ({ ...current, [item.id]: message }));
        if (windowClosed) {
          // The window closed while the page was open: read it again so the
          // row trades its cancel button for the note, and keep focus on the row.
          setNow(new Date());
          focusIdRef.current = titleId(item.id);
        } else {
          focusIdRef.current = cancelButtonId(item.id);
        }
      } finally {
        setCancellingId(null);
      }
    },
    [client, headingId, t],
  );

  const dateFmt = useMemo(
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

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} tabIndex={-1} className="text-xl font-semibold outline-none">
        {t('classes.upcoming.title')}
      </h2>

      {load.kind === 'loading' ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : load.kind === 'error' ? (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-sm text-destructive">{t('errors.generic')}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : load.items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
          <p className="text-muted-foreground">{t('classes.upcoming.empty')}</p>
          <Link href="/classes" className={buttonVariants({ size: 'sm' })}>
            {t('web.home.classes')}
          </Link>
        </div>
      ) : (
        <ul aria-labelledby={headingId} className="flex list-none flex-col gap-3 p-0">
          {load.items.map((item) => {
            const error = errorById[item.id];
            return (
              <li
                key={item.id}
                className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p id={titleId(item.id)} tabIndex={-1} className="font-semibold outline-none">
                    {item.class.title}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={item.class.startsAt} className="tabular-nums">
                      {dateFmt.format(new Date(item.class.startsAt))}
                    </time>
                    {' · '}
                    {t('classes.card.duration', { minutes: item.class.durationMin })}
                  </p>
                  {item.status === 'confirmed' ? (
                    <p className="flex items-center gap-1.5 text-sm font-medium text-success">
                      <CheckCircleIcon weight="fill" className="size-4" aria-hidden="true" />
                      {t('classes.upcoming.confirmed')}
                    </p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <HourglassMediumIcon className="size-4" aria-hidden="true" />
                      {t('classes.upcoming.waitlist')}
                    </p>
                  )}
                  {item.status === 'confirmed' ? (
                    <AddToCalendar
                      event={{
                        classId: item.classId,
                        reservationId: item.id,
                        title: item.class.title,
                        startsAt: item.class.startsAt,
                        durationMin: item.class.durationMin,
                      }}
                      t={t}
                    />
                  ) : null}
                  {error !== undefined ? (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!canCancel(item, now) ? (
                    <p className="text-sm text-muted-foreground">
                      {t('classes.upcoming.cancelClosed')}
                    </p>
                  ) : confirmingId === item.id ? (
                    <>
                      <p className="text-sm font-medium">{t('classes.upcoming.confirmPrompt')}</p>
                      <Button
                        id={confirmButtonId(item.id)}
                        size="sm"
                        onClick={() => void cancel(item)}
                      >
                        {t('classes.upcoming.confirmCancel')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => keep(item.id)}>
                        {t('classes.upcoming.keep')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      id={cancelButtonId(item.id)}
                      size="sm"
                      variant="outline"
                      disabled={cancellingId === item.id}
                      aria-label={t('classes.upcoming.cancelLabel', { title: item.class.title })}
                      onClick={() => askConfirmation(item.id)}
                    >
                      {t('classes.upcoming.cancel')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
