'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import Image from 'next/image';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { newIdempotencyKey } from '../../../lib/idempotency';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { createFrameDecoder } from './qr-frame-decoder';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type CheckInFailCode =
  | 'invalid_signature'
  | 'token_expired'
  | 'replay'
  | 'wrong_studio'
  | 'wrong_kind'
  | 'malformed'
  | 'outside_window'
  | 'no_reservation'
  | 'already_checked_in'
  | 'checkin_limit_reached';

const KNOWN_FAIL_CODES: ReadonlySet<string> = new Set<CheckInFailCode>([
  'invalid_signature',
  'token_expired',
  'replay',
  'wrong_studio',
  'wrong_kind',
  'malformed',
  'outside_window',
  'no_reservation',
  'already_checked_in',
  'checkin_limit_reached',
]);

/** Why the camera is not showing a live picture, when it is not. */
export type CameraStatus = 'starting' | 'active' | 'denied' | 'not_found' | 'unsupported' | 'error';

interface CheckInSuccessResponse {
  readonly success: true;
  readonly reservationId: string;
  readonly member: {
    readonly id: string;
    readonly displayName: string;
    readonly avatarUrl: string | null;
  };
}

type KioskState =
  | { readonly kind: 'scanning' }
  | { readonly kind: 'submitting' }
  | {
      readonly kind: 'success';
      readonly member: CheckInSuccessResponse['member'];
      readonly countdown: number;
    }
  | { readonly kind: 'error'; readonly message: string };

const SUCCESS_COUNTDOWN_SECONDS = 5;

/** Minimum gap between two decoded frames: about 8 per second. */
export const DECODE_INTERVAL_MS = 125;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function canUseCamera(): boolean {
  return (
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function resolveErrorMessage(
  code: string | undefined,
  t: ReturnType<typeof createTranslator>,
): string {
  if (code === undefined || !KNOWN_FAIL_CODES.has(code)) return t('studio.checkin.errors.generic');
  const key = `studio.checkin.errors.${code}` as Parameters<typeof t>[0];
  return t(key);
}

function cameraStatusFromError(err: unknown): CameraStatus {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  return 'error';
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

interface ManualInputProps {
  readonly onSubmit: (token: string) => void;
  readonly disabled: boolean;
  readonly t: ReturnType<typeof createTranslator>;
}

function ManualInput({ onSubmit, disabled, t }: ManualInputProps): ReactElement {
  const [token, setToken] = useState('');

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setToken('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md">
      <div className="flex flex-col gap-1">
        <Label htmlFor="qr-token-input">{t('studio.checkin.manualLabel')}</Label>
        <Input
          id="qr-token-input"
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('studio.checkin.manualPlaceholder')}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <Button type="submit" disabled={disabled || token.trim().length === 0}>
        {t('studio.checkin.manualSubmit')}
      </Button>
    </form>
  );
}

interface SuccessBannerProps {
  readonly member: CheckInSuccessResponse['member'];
  readonly countdown: number;
  readonly t: ReturnType<typeof createTranslator>;
}

function SuccessBanner({ member, countdown, t }: SuccessBannerProps): ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-xl border border-green-500 bg-green-50 p-8 text-center dark:bg-green-950"
    >
      {member.avatarUrl !== null && member.avatarUrl !== '' ? (
        <Image
          src={member.avatarUrl}
          alt=""
          width={80}
          height={80}
          unoptimized
          className="size-20 rounded-full border-2 border-green-500 object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex size-20 items-center justify-center rounded-full border-2 border-green-500 bg-green-100 text-3xl font-semibold text-green-700 dark:bg-green-900 dark:text-green-300"
        >
          {member.displayName.charAt(0).toUpperCase() || '?'}
        </div>
      )}
      <p className="text-2xl font-semibold text-green-800 dark:text-green-200">
        {member.displayName.trim().length > 0
          ? t('studio.checkin.success', { name: member.displayName })
          : t('studio.checkin.successNoName')}
      </p>
      <p className="text-sm text-green-600 dark:text-green-400">
        {t('studio.checkin.resetIn', { seconds: countdown })}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Camera scanner hook                                                */
/* ------------------------------------------------------------------ */

interface UseCameraScannerOptions {
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly onDetected: (token: string) => void;
  readonly enabled: boolean;
}

/**
 * Opens the rear camera while `enabled`, decodes at most one frame per
 * {@link DECODE_INTERVAL_MS} and reports the first QR payload found.
 * The callback is read through a ref so a parent re-render never
 * restarts the camera.
 */
export function useCameraScanner({
  videoRef,
  onDetected,
  enabled,
}: UseCameraScannerOptions): CameraStatus {
  const [status, setStatus] = useState<CameraStatus>(() =>
    canUseCamera() ? 'starting' : 'unsupported',
  );
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    if (!enabled || !canUseCamera()) return;
    // A blocked status hides the <video>; reset it so a restart can mount it again.
    setStatus('starting');

    let cancelled = false;
    let timer: number | null = null;
    let stream: MediaStream | null = null;

    async function start(): Promise<void> {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (err: unknown) {
        if (!cancelled) setStatus(cameraStatusFromError(err));
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const video = videoRef.current;
      if (video === null) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
        setStatus('error');
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err: unknown) {
        if (!cancelled) setStatus(cameraStatusFromError(err));
        return;
      }
      if (cancelled) return;
      setStatus('active');

      const decode = await createFrameDecoder();

      async function tick(): Promise<void> {
        if (cancelled) return;
        const current = videoRef.current;
        let found: string | null = null;
        if (current !== null && current.readyState >= 2) {
          try {
            found = await decode(current);
          } catch {
            found = null;
          }
        }
        if (cancelled) return;
        if (found !== null) {
          onDetectedRef.current(found);
          return;
        }
        timer = window.setTimeout(() => void tick(), DECODE_INTERVAL_MS);
      }

      void tick();
    }

    void start();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
  }, [enabled, videoRef]);

  return status;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function CheckinKiosk(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [state, setState] = useState<KioskState>({ kind: 'scanning' });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const cameraStatus = useCameraScanner({
    videoRef,
    onDetected: (token) => void submitToken(token),
    enabled: state.kind === 'scanning',
  });
  const cameraBlocked =
    cameraStatus === 'denied' ||
    cameraStatus === 'not_found' ||
    cameraStatus === 'unsupported' ||
    cameraStatus === 'error';

  useEffect(() => {
    if (state.kind !== 'success') return;
    if (state.countdown <= 0) {
      setState({ kind: 'scanning' });
      return;
    }
    const timer = window.setTimeout(() => {
      setState((prev) =>
        prev.kind === 'success' ? { ...prev, countdown: prev.countdown - 1 } : prev,
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [state]);

  async function submitToken(qrToken: string): Promise<void> {
    setState({ kind: 'submitting' });
    try {
      const response = await client.post<CheckInSuccessResponse>(
        '/v1/checkins',
        { qrToken },
        { headers: { 'Idempotency-Key': newIdempotencyKey() } },
      );
      setState({
        kind: 'success',
        member: response.member,
        countdown: SUCCESS_COUNTDOWN_SECONDS,
      });
    } catch (err: unknown) {
      const code = err instanceof ApiError ? err.problem?.code : undefined;
      setState({ kind: 'error', message: resolveErrorMessage(code, t) });
    }
  }

  function reset(): void {
    setState({ kind: 'scanning' });
  }

  return (
    <div className="flex flex-col gap-6">
      {state.kind === 'success' ? (
        <SuccessBanner member={state.member} countdown={state.countdown} t={t} />
      ) : null}

      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      {state.kind === 'error' ? (
        <Button variant="outline" onClick={reset} className="self-start">
          {t('common.retry')}
        </Button>
      ) : null}

      {state.kind !== 'success' ? (
        <>
          {cameraBlocked ? (
            <p
              role="status"
              data-testid="checkin-camera-status"
              className="text-sm text-muted-foreground"
            >
              {t(`studio.checkin.camera.${cameraStatus}` as Parameters<typeof t>[0])}{' '}
              {t('studio.checkin.noCameraFallback')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                {cameraStatus === 'starting'
                  ? t('studio.checkin.camera.starting')
                  : t('studio.checkin.scanPrompt')}
              </p>
              <video
                ref={videoRef}
                aria-label={t('studio.checkin.scanPrompt')}
                className="w-full max-w-md rounded-lg border border-border bg-black"
                muted
                playsInline
              />
            </div>
          )}

          <ManualInput
            onSubmit={(token) => void submitToken(token)}
            disabled={state.kind === 'submitting'}
            t={t}
          />
        </>
      ) : null}
    </div>
  );
}
