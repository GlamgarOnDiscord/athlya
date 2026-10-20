/**
 * `<CheckinPanel />` — the member's check-in QR code on the web (task
 * 11.9, Requirement 11.1), for members who do not use the mobile app.
 *
 * The token is a single-use RS256 JWT issued by `POST /v1/checkins/token`
 * and valid 120 s. The panel fetches one, shows a countdown, and fetches
 * the next one {@link REFRESH_MARGIN_MS} before it expires, but only
 * while the tab is visible: a hidden tab stops the timers, and coming
 * back fetches a new code when the current one is about to expire.
 * Offline, a still-valid code stays on screen; a new one is fetched as
 * soon as the browser is back online.
 *
 * Optional `client`, `t` and `now` props are test seams.
 */
'use client';

import { CheckInTokenResponseSchema } from '@athlya/shared/schemas/api';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';

import { ApiError } from '../../../lib/api/client';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { encodeQrMatrix, qrMatrixPath } from '../../../lib/qr/qr-matrix';

import type { ApiClient } from '../../../lib/api/client';

export const CHECKIN_TOKEN_PATH = '/v1/checkins/token';
/** Fetch the next code this long before the current one expires. */
export const REFRESH_MARGIN_MS = 15_000;
/** Retry delay after a 429: the token budget is per minute. */
export const RATE_LIMIT_RETRY_MS = 60_000;
/** Retry delay after any other failure. */
export const ERROR_RETRY_MS = 10_000;
/** Blank modules around the code, as the QR specification asks. */
const QUIET_ZONE = 4;

export interface CheckinPanelProps {
  readonly client?: ApiClient;
  readonly t?: Translator;
  /** Unix ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly token: string; readonly expiresAt: number }
  | { readonly kind: 'offline' }
  | { readonly kind: 'error' };

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function QrSvg({ token, label }: { readonly token: string; readonly label: string }): ReactElement {
  const { path, size } = useMemo(() => {
    const matrix = encodeQrMatrix(token);
    return { path: qrMatrixPath(matrix), size: matrix.length };
  }, [token]);
  const box = size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="checkin-qr"
      viewBox={`${String(-QUIET_ZONE)} ${String(-QUIET_ZONE)} ${String(box)} ${String(box)}`}
      shapeRendering="crispEdges"
      className="aspect-square w-full max-w-72 rounded-lg bg-white"
    >
      <path d={path} fill="#0A0A0A" />
    </svg>
  );
}

export function CheckinPanel({
  client: clientProp,
  t: tProp,
  now = Date.now,
}: CheckinPanelProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);
  const client = useApiClient(clientProp);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timer = useRef<number | null>(null);
  // The fetch reschedules itself; the timer goes through this ref so the
  // callback always runs the latest `fetchToken`.
  const fetchRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const statusRef = useRef<Status>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const clearTimer = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const fetchToken = useCallback(async (): Promise<void> => {
    if (inFlight.current || !isVisible()) return;
    clearTimer();
    if (!isOnline()) {
      const current = statusRef.current;
      if (current.kind !== 'ready' || current.expiresAt <= now()) setStatus({ kind: 'offline' });
      return;
    }
    inFlight.current = true;
    if (statusRef.current.kind !== 'ready') setStatus({ kind: 'loading' });
    try {
      const raw = await client.post<unknown>(CHECKIN_TOKEN_PATH, {});
      if (!mounted.current) return;
      const parsed = CheckInTokenResponseSchema.parse(raw);
      const expiresAt = Date.parse(parsed.expiresAt);
      setStatus({ kind: 'ready', token: parsed.token, expiresAt });
      const delay = Math.max(1_000, expiresAt - REFRESH_MARGIN_MS - now());
      timer.current = window.setTimeout(() => void fetchRef.current(), delay);
    } catch (err: unknown) {
      if (!mounted.current) return;
      const retry =
        err instanceof ApiError && err.status === 429 ? RATE_LIMIT_RETRY_MS : ERROR_RETRY_MS;
      setStatus(isOnline() ? { kind: 'error' } : { kind: 'offline' });
      timer.current = window.setTimeout(() => void fetchRef.current(), retry);
    } finally {
      inFlight.current = false;
    }
  }, [client, clearTimer, now]);

  useEffect(() => {
    fetchRef.current = fetchToken;
  }, [fetchToken]);

  useEffect(() => {
    void fetchToken();

    function onVisibility(): void {
      if (!isVisible()) {
        clearTimer();
        return;
      }
      const current = statusRef.current;
      if (current.kind !== 'ready' || current.expiresAt - now() <= REFRESH_MARGIN_MS) {
        void fetchToken();
      } else {
        timer.current = window.setTimeout(
          () => void fetchToken(),
          current.expiresAt - REFRESH_MARGIN_MS - now(),
        );
      }
    }
    function onOnline(): void {
      void fetchToken();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      clearTimer();
    };
  }, [fetchToken, clearTimer, now]);

  useEffect(() => {
    if (status.kind !== 'ready') return;
    const tick = (): void =>
      setSecondsLeft(Math.max(0, Math.ceil((status.expiresAt - now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [status, now]);

  return (
    <section aria-labelledby="checkin-heading" className="flex flex-col items-center gap-6">
      <p className="text-center text-sm text-muted-foreground">{t('checkin.intro')}</p>

      {status.kind === 'ready' ? (
        <>
          <QrSvg token={status.token} label={t('checkin.qrLabel', { seconds: secondsLeft })} />
          <p className="text-sm tabular-nums text-muted-foreground" aria-live="off">
            {t('checkin.qrExpiresIn', { seconds: secondsLeft })}
          </p>
        </>
      ) : null}

      {status.kind === 'loading' ? (
        <div
          aria-busy="true"
          className="flex aspect-square w-full max-w-72 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground"
        >
          {t('checkin.loading')}
        </div>
      ) : null}

      {status.kind === 'offline' ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t('checkin.offline')}
        </p>
      ) : null}

      {status.kind === 'error' ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {t('checkin.loadError')}
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        data-testid="checkin-refresh"
        disabled={status.kind === 'loading'}
        onClick={() => void fetchToken()}
      >
        {t('checkin.refresh')}
      </Button>
    </section>
  );
}
