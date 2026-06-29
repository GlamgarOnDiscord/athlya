/**
 * Cloudflare Turnstile challenge widget — studio admin copy.
 *
 * Mirror of `apps/web/src/components/TurnstileWidget.tsx`. Same
 * single-use-token contract, same per-page script injection, same
 * imperative `reset()` handle exposed via `ref`. See the web copy
 * for the full rationale.
 *
 * @see Requirements 26.1, 26.2, 26.3.
 */
'use client';

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactElement,
  type Ref,
} from 'react';

import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export interface TurnstileWidgetHandle {
  reset(): void;
}

export interface TurnstileWidgetProps {
  readonly siteKey: string | undefined;
  readonly onToken: (token: string) => void;
  readonly nonce: string;
  readonly ref?: Ref<TurnstileWidgetHandle>;
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(nonce: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile !== undefined) return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );
    if (existing !== null) {
      if (window.turnstile !== undefined) {
        resolve();
      } else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () =>
          reject(new Error('Failed to load Turnstile script')),
        );
      }
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    if (nonce !== '') script.setAttribute('nonce', nonce);
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Failed to load Turnstile script')));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  nonce,
  ref,
}: TurnstileWidgetProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const keyConfigured = siteKey !== undefined && siteKey !== '';

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        if (
          typeof window === 'undefined' ||
          window.turnstile === undefined ||
          widgetIdRef.current === null
        ) {
          return;
        }
        window.turnstile.reset(widgetIdRef.current);
        onToken('');
      },
    }),
    [onToken],
  );

  useEffect(() => {
    if (!keyConfigured) return;
    let cancelled = false;

    loadTurnstileScript(nonce)
      .then(() => {
        if (cancelled) return;
        const container = containerRef.current;
        if (container === null || window.turnstile === undefined) return;
        const id = window.turnstile.render(container, {
          sitekey: siteKey as string,
          'refresh-expired': 'auto',
          callback: (token: string) => onToken(token),
          'error-callback': () => onToken(''),
          'expired-callback': () => {
            onToken('');
            if (
              typeof window !== 'undefined' &&
              window.turnstile !== undefined &&
              widgetIdRef.current !== null
            ) {
              try {
                window.turnstile.reset(widgetIdRef.current);
              } catch {
                // Widget already gone.
              }
            }
          },
          'timeout-callback': () => {
            onToken('');
            if (
              typeof window !== 'undefined' &&
              window.turnstile !== undefined &&
              widgetIdRef.current !== null
            ) {
              try {
                window.turnstile.reset(widgetIdRef.current);
              } catch {
                // Widget already gone.
              }
            }
          },
        });
        if (typeof id === 'string') {
          widgetIdRef.current = id;
        }
      })
      .catch(() => {
        // Script load failed — submit guard already blocks.
      });

    return () => {
      cancelled = true;
      if (
        typeof window !== 'undefined' &&
        window.turnstile !== undefined &&
        widgetIdRef.current !== null
      ) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      onToken('');
    };
  }, [keyConfigured, siteKey, nonce, onToken]);

  if (!keyConfigured) {
    return (
      <output
        className="block rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        data-testid="turnstile-widget-devwarning"
      >
        {t('web.turnstile.notConfigured')}
      </output>
    );
  }

  return <div ref={containerRef} data-testid="turnstile-widget" className="cf-turnstile" />;
}
