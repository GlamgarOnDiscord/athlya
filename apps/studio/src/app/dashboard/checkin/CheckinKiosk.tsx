'use client';

import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CheckCircleIcon,
  InfoIcon,
  KeyReturnIcon,
  WarningIcon,
} from '@phosphor-icons/react';
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

import { PageHeader } from '../../../components/shell/PageHeader';
import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { pluralKey } from '../../../lib/i18n/plural';
import { createTranslator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';
import { initials } from '../members/members-view';

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
  | { readonly kind: 'error'; readonly message: string; readonly code: string | undefined };

const SUCCESS_COUNTDOWN_SECONDS = 5;
/** Check-ins of this kiosk session listed beside the scanner. */
const SESSION_PASSES_SHOWN = 8;
const CARD = 'flex flex-col rounded-lg border border-border bg-card text-card-foreground';
/** In kiosk mode on a wide screen, the scanner column grows to the free height. */
const KIOSK_FILL =
  'lg:group-data-[kiosk=true]/kiosk:min-h-0 lg:group-data-[kiosk=true]/kiosk:flex-1';

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
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
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={disabled || token.trim().length === 0}>
          {t('studio.checkin.manualSubmit')}
        </Button>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('studio.checkin.enterHint')}
          <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-xs text-foreground">
            <KeyReturnIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">{t('studio.checkin.enterKey')}</span>
          </kbd>
        </span>
      </div>
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
  const barRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    barRef.current?.style.setProperty(
      '--fill',
      `${String((countdown / SUCCESS_COUNTDOWN_SECONDS) * 100)}%`,
    );
  }, [countdown]);
  return (
    <div role="alert" className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {member.avatarUrl !== null && member.avatarUrl !== '' ? (
            <Image
              src={member.avatarUrl}
              alt=""
              width={56}
              height={56}
              unoptimized
              className="size-14 shrink-0 rounded-full border border-border object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-14 shrink-0 place-items-center rounded-full border border-border bg-muted text-lg font-semibold"
            >
              {initials(member.displayName)}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-xl font-semibold break-words">
              {named
                ? t('studio.checkin.success', { name: member.displayName })
                : t('studio.checkin.successNoName')}
            </p>
            {named ? (
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
                <CheckCircleIcon aria-hidden="true" weight="fill" className="size-4" />
                {t('studio.checkin.confirmed')}
              </p>
            ) : null}
          </div>
        </div>
        <Button variant="outline" onClick={onNext} className="w-full sm:w-auto">
          {t('studio.checkin.scanNext')}
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
          <span ref={barRef} className="fill-meter-bar block h-full rounded-full bg-chart-1" />
        </span>
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('studio.checkin.resetIn', { seconds: countdown })}
        </p>
      </div>
    </div>
  );
}

interface SessionPass {
  readonly reservationId: string;
  readonly name: string;
  readonly at: Date;
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
  const [passes, setPasses] = useState<ReadonlyArray<SessionPass>>([]);
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
      setPasses((prev) =>
        [
          {
            reservationId: response.reservationId,
            name: response.member.displayName,
            at: new Date(),
          },
          ...prev,
        ].slice(0, SESSION_PASSES_SHOWN),
      );
    } catch (err: unknown) {
      const code = err instanceof ApiError ? err.problem?.code : undefined;
      setState({
        kind: 'error',
        message: resolveErrorMessage(code, t),
        code: code !== undefined && KNOWN_FAIL_CODES.has(code) ? code : undefined,
      });
    }
  }

  function reset(): void {
    setState({ kind: 'scanning' });
  }

  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      ref={kioskRef}
      data-kiosk={kiosk.active}
      className="group/kiosk flex min-h-0 flex-col gap-6 data-[kiosk=true]:overflow-auto data-[kiosk=true]:bg-background data-[kiosk=true]:p-8 data-[kiosk=true]:text-foreground"
    >
      <PageHeader
        title={t('studio.checkin.title')}
        subtitle={t('studio.checkin.subtitle')}
        actions={
          kiosk.supported ? (
            <Button variant="outline" size="lg" onClick={kiosk.toggle} aria-pressed={kiosk.active}>
              {kiosk.active ? (
                <ArrowsInIcon aria-hidden="true" data-icon="inline-start" />
              ) : (
                <ArrowsOutIcon aria-hidden="true" data-icon="inline-start" />
              )}
              {kiosk.active ? t('studio.checkin.kiosk.exit') : t('studio.checkin.kiosk.enter')}
            </Button>
          ) : undefined
        }
      />

      <div className={`grid grid-cols-1 gap-4 lg:grid-cols-12 ${KIOSK_FILL}`}>
        <div className="flex min-h-0 flex-col gap-4 lg:col-span-7">
          <section aria-labelledby="checkin-scanner" className={`${CARD} ${KIOSK_FILL}`}>
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2">
              <h2 id="checkin-scanner" className="flex items-baseline gap-2 text-sm font-semibold">
                {t('studio.checkin.scanner.title')}
                <span className="text-xs font-normal text-muted-foreground">
                  {t('studio.checkin.scanner.camera')}
                </span>
              </h2>
            </div>
            <div className={`flex flex-col p-4 ${KIOSK_FILL}`}>
              {cameraBlocked ? (
                <p
                  role="status"
                  data-testid="checkin-camera-status"
                  className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground"
                >
                  <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {t(`studio.checkin.camera.${cameraStatus}` as Parameters<typeof t>[0])}{' '}
                    {t('studio.checkin.noCameraFallback')}
                  </span>
                </p>
              ) : (
                <div
                  className={`kiosk-video relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-border group-data-[kiosk=true]/kiosk:aspect-video lg:group-data-[kiosk=true]/kiosk:aspect-auto ${KIOSK_FILL}`}
                >
                  <video
                    ref={videoRef}
                    aria-label={t('studio.checkin.scanPrompt')}
                    className="size-full object-cover"
                    muted
                    playsInline
                  />
                  {cameraStatus === 'active' && state.kind === 'scanning' ? (
                    <span className="planning-pill-open absolute top-3 left-3 rounded-md px-1.5 py-0.5 text-xs font-medium">
                      {t('studio.checkin.scanner.active')}
                    </span>
                  ) : null}
                  <div
                    aria-hidden="true"
                    data-testid="checkin-frame-guide"
                    className="pointer-events-none absolute inset-0 flex items-center justify-center"
                  >
                    <div className="relative aspect-square h-1/2">
                      <span className="kiosk-guide-corner absolute top-0 left-0 size-8 rounded-tl-lg border-t-4 border-l-4" />
                      <span className="kiosk-guide-corner absolute top-0 right-0 size-8 rounded-tr-lg border-t-4 border-r-4" />
                      <span className="kiosk-guide-corner absolute bottom-0 left-0 size-8 rounded-bl-lg border-b-4 border-l-4" />
                      <span className="kiosk-guide-corner absolute right-0 bottom-0 size-8 rounded-br-lg border-r-4 border-b-4" />
                    </div>
                  </div>
                  <p className="kiosk-caption absolute inset-x-0 bottom-0 px-4 py-2 text-center text-sm">
                    {cameraStatus === 'starting'
                      ? t('studio.checkin.camera.starting')
                      : `${t('studio.checkin.scanPrompt')} ${t('studio.checkin.frameHint')}`}
                  </p>
                </div>
              )}
            </div>
          </section>

          {state.kind === 'success' ? (
            <SuccessBanner member={state.member} countdown={state.countdown} onNext={reset} t={t} />
          ) : null}

          {state.kind === 'error' ? (
            <div
              role="alert"
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
            >
              <p className="flex items-start gap-2 text-sm font-medium text-destructive">
                <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="flex flex-col gap-0.5">
                  {state.message}
                  {state.code === undefined ? null : (
                    <span className="font-mono text-xs font-normal">{state.code}</span>
                  )}
                </span>
              </p>
              <Button variant="outline" onClick={reset}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 lg:col-span-5">
          <section aria-labelledby="checkin-manual" className={CARD}>
            <div className="flex min-h-12 items-center border-b border-border px-4 py-2">
              <h2
                id="checkin-manual"
                className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold"
              >
                {t('studio.checkin.manual.title')}
                <span className="text-xs font-normal text-muted-foreground">
                  {t('studio.checkin.manual.hint')}
                </span>
              </h2>
            </div>
            <div className="p-4">
              <ManualInput
                onSubmit={(token) => void submitToken(token)}
                disabled={state.kind === 'submitting'}
                t={t}
              />
            </div>
          </section>

          <section aria-labelledby="checkin-passes" className={CARD}>
            <div className="flex min-h-12 items-center border-b border-border px-4 py-2">
              <h2 id="checkin-passes" className="flex items-baseline gap-2 text-sm font-semibold">
                {t('studio.checkin.passes.title')}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {t(
                    pluralKey(locale, passes.length, {
                      one: 'studio.checkin.passes.countOne',
                      other: 'studio.checkin.passes.countOther',
                    }),
                    { count: passes.length },
                  )}
                </span>
              </h2>
            </div>
            {passes.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {t('studio.checkin.passes.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {passes.map((pass) => (
                  <li
                    key={pass.reservationId}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm"
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-muted text-[0.6875rem] font-medium"
                    >
                      {initials(pass.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {pass.name.trim() === '' ? t('studio.checkin.passes.unnamed') : pass.name}
                    </span>
                    <time
                      dateTime={pass.at.toISOString()}
                      className="text-xs text-muted-foreground tabular-nums"
                    >
                      {time.format(pass.at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {t('studio.checkin.passes.note')}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
