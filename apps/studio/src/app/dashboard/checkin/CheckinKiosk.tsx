'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

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
  | 'no_reservation';

interface CheckInSuccessResponse {
  readonly success: true;
  readonly reservationId: string;
  readonly member: {
    readonly id: string;
    readonly displayName: string;
    readonly avatarUrl: string | null;
  };
}

interface CheckInErrorResponse {
  readonly code: CheckInFailCode;
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isBarcodeDetectorAvailable(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

function resolveErrorMessage(
  code: CheckInFailCode | undefined,
  t: ReturnType<typeof createTranslator>,
): string {
  if (code === undefined) return t('studio.checkin.errors.generic');
  const key = `studio.checkin.errors.${code}` as Parameters<typeof t>[0];
  return t(key);
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
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={member.avatarUrl}
          alt=""
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
        {t('studio.checkin.success', { name: member.displayName })}
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

function useCameraScanner({ videoRef, onDetected, enabled }: UseCameraScannerOptions): void {
  const detectedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function startCamera(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        streamRef.current = stream;
        if (videoRef.current !== null) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        return;
      }

      // BarcodeDetector is a global Web API — not in TypeScript lib yet.
      // We checked availability before enabling, so this cast is safe.
      const detector = new (
        window as unknown as {
          BarcodeDetector: new (opts: { formats: string[] }) => {
            detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
          };
        }
      ).BarcodeDetector({ formats: ['qr_code'] });

      function poll(): void {
        if (cancelled || detectedRef.current) return;
        const video = videoRef.current;
        if (video === null || video.readyState < 2) {
          rafRef.current = requestAnimationFrame(poll);
          return;
        }
        detector
          .detect(video)
          .then((barcodes) => {
            if (cancelled || detectedRef.current) return;
            const first = barcodes[0];
            if (barcodes.length > 0 && first !== undefined && first.rawValue.length > 0) {
              detectedRef.current = true;
              onDetected(first.rawValue);
            } else {
              rafRef.current = requestAnimationFrame(poll);
            }
          })
          .catch(() => {
            if (!cancelled) rafRef.current = requestAnimationFrame(poll);
          });
      }

      rafRef.current = requestAnimationFrame(poll);
    }

    void startCamera();

    return () => {
      cancelled = true;
      detectedRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (streamRef.current !== null) {
        for (const track of streamRef.current.getTracks()) track.stop();
        streamRef.current = null;
      }
    };
  }, [enabled, onDetected, videoRef]);
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
  const [cameraAvailable] = useState(() => isBarcodeDetectorAvailable());

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isCameraActive = state.kind === 'scanning' && cameraAvailable;

  useCameraScanner({
    videoRef,
    onDetected: (token) => void submitToken(token),
    enabled: isCameraActive,
  });

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
      const idempotencyKey = `checkin-${qrToken.slice(-16)}-${Date.now()}`;
      const response = await client.post<CheckInSuccessResponse | CheckInErrorResponse>(
        '/v1/checkins',
        { qrToken },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );

      if ('success' in response && response.success === true) {
        setState({
          kind: 'success',
          member: (response as CheckInSuccessResponse).member,
          countdown: SUCCESS_COUNTDOWN_SECONDS,
        });
      } else {
        const code = (response as CheckInErrorResponse).code;
        setState({ kind: 'error', message: resolveErrorMessage(code, t) });
      }
    } catch {
      setState({ kind: 'error', message: t('studio.checkin.errors.generic') });
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
          {cameraAvailable ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t('studio.checkin.scanPrompt')}</p>
              <video
                ref={videoRef}
                aria-label={t('studio.checkin.scanPrompt')}
                className="w-full max-w-md rounded-lg border border-border bg-black"
                muted
                playsInline
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('studio.checkin.noCameraFallback')}</p>
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
