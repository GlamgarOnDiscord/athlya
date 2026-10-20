'use client';

import { ArrowsInIcon, ArrowsOutIcon, CheckCircleIcon } from '@phosphor-icons/react';
import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

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
    <form
      onSubmit={handleSubmit}
      className="flex w-full max-w-md flex-col gap-3 group-data-[kiosk=true]/kiosk:max-w-2xl"
    >
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
  readonly onNext: () => void;
  readonly t: ReturnType<typeof createTranslator>;
}

function SuccessBanner({ member, countdown, onNext, t }: SuccessBannerProps): ReactElement {
  const named = member.displayName.trim().length > 0;
  return (
    <div
      role="alert"
      className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center text-card-foreground group-data-[kiosk=true]/kiosk:max-w-2xl"
    >
      {member.avatarUrl !== null && member.avatarUrl !== '' ? (
        <Image
          src={member.avatarUrl}
          alt=""
          width={96}
          height={96}
          unoptimized
          className="size-24 rounded-full border border-border object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex size-24 items-center justify-center rounded-full border border-border bg-muted text-4xl font-semibold"
        >
          {member.displayName.charAt(0).toUpperCase() || '?'}
        </div>
      )}
      {named ? (
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircleIcon aria-hidden="true" weight="fill" className="size-5" />
          {t('studio.checkin.confirmed')}
        </p>
      ) : null}
      <p className="text-3xl font-semibold">
        {named
          ? t('studio.checkin.success', { name: member.displayName })
          : t('studio.checkin.successNoName')}
      </p>
      <p className="text-sm text-muted-foreground tabular-nums">
        {t('studio.checkin.resetIn', { seconds: countdown })}
      </p>
      <Button variant="outline" onClick={onNext}>
        {t('studio.checkin.scanNext')}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Kiosk mode (Fullscreen API)                                        */
/* ------------------------------------------------------------------ */

function subscribeToFullscreen(onStoreChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onStoreChange);
  return () => document.removeEventListener('fullscreenchange', onStoreChange);
}

/**
 * Full-screen state of `target`, and a toggle. `supported` is false during
 * server rendering and in browsers without the Fullscreen API, where the
 * toggle is not offered. Escape leaves full screen natively.
 */
function useKioskMode(target: React.RefObject<HTMLElement | null>): {
  readonly supported: boolean;
  readonly active: boolean;
  readonly toggle: () => void;
} {
  const supported = useSyncExternalStore(
    subscribeToFullscreen,
    () => document.fullscreenEnabled,
    () => false,
  );
  const active = useSyncExternalStore(
    subscribeToFullscreen,
    () => document.fullscreenElement !== null && document.fullscreenElement === target.current,
    () => false,
  );
  const toggle = useCallback(() => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();
      return;
    }
    void target.current?.requestFullscreen().catch(() => undefined);
  }, [target]);
  return { supported, active, toggle };
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
  const kioskRef = useRef<HTMLDivElement | null>(null);
  const kiosk = useKioskMode(kioskRef);

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
    <div
      ref={kioskRef}
      data-kiosk={kiosk.active}
      className="group/kiosk flex flex-col gap-6 data-[kiosk=true]:items-center data-[kiosk=true]:justify-center data-[kiosk=true]:overflow-auto data-[kiosk=true]:bg-background data-[kiosk=true]:p-8 data-[kiosk=true]:text-foreground"
    >
      {kiosk.supported ? (
        <Button
          variant="outline"
          onClick={kiosk.toggle}
          aria-pressed={kiosk.active}
          className="self-start group-data-[kiosk=true]/kiosk:fixed group-data-[kiosk=true]/kiosk:top-6 group-data-[kiosk=true]/kiosk:right-6"
        >
          {kiosk.active ? (
            <ArrowsInIcon aria-hidden="true" data-icon="inline-start" />
          ) : (
            <ArrowsOutIcon aria-hidden="true" data-icon="inline-start" />
          )}
          {kiosk.active ? t('studio.checkin.kiosk.exit') : t('studio.checkin.kiosk.enter')}
        </Button>
      ) : null}

      {state.kind === 'success' ? (
        <SuccessBanner member={state.member} countdown={state.countdown} onNext={reset} t={t} />
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
            <div className="flex w-full max-w-md flex-col gap-2 group-data-[kiosk=true]/kiosk:max-w-2xl">
              <p className="text-sm text-muted-foreground">
                {cameraStatus === 'starting'
                  ? t('studio.checkin.camera.starting')
                  : `${t('studio.checkin.scanPrompt')} ${t('studio.checkin.frameHint')}`}
              </p>
              <div className="kiosk-video relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-border">
                <video
                  ref={videoRef}
                  aria-label={t('studio.checkin.scanPrompt')}
                  className="size-full object-cover"
                  muted
                  playsInline
                />
                <div
                  aria-hidden="true"
                  data-testid="checkin-frame-guide"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <div className="relative aspect-square h-3/5">
                    <span className="kiosk-guide-corner absolute top-0 left-0 size-8 rounded-tl-lg border-t-4 border-l-4" />
                    <span className="kiosk-guide-corner absolute top-0 right-0 size-8 rounded-tr-lg border-t-4 border-r-4" />
                    <span className="kiosk-guide-corner absolute bottom-0 left-0 size-8 rounded-bl-lg border-b-4 border-l-4" />
                    <span className="kiosk-guide-corner absolute right-0 bottom-0 size-8 rounded-br-lg border-r-4 border-b-4" />
                  </div>
                </div>
              </div>
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
