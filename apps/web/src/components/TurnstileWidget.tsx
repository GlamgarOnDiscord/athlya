/**
 * Cloudflare Turnstile challenge widget.
 *
 * Wraps the vendor's `<script>` + imperative `turnstile.render` API in
 * a React component so pages can drop one in anywhere a form needs
 * anti-bot protection. The Athlya CSP already whitelists
 * `https://challenges.cloudflare.com` on `script-src` and `frame-src`
 * (see `src/lib/csp.ts`), so the loaded script and the iframe it
 * injects are allowed out of the box.
 *
 * Behaviour
 * ---------
 *  - The vendor script is injected exactly once per page lifetime.
 *    Subsequent mounts re-use the existing `window.turnstile` global.
 *  - When `siteKey` is empty / undefined, we render a non-blocking
 *    yellow banner (`Turnstile non configuré`) instead of mounting
 *    the challenge. This keeps local dev productive; production CSP
 *    and the gateway Turnstile middleware will reject requests with
 *    a missing token, so no challenge being mounted means no token
 *    emitted — a hard fail-closed posture at the wire level.
 *  - The CSP `nonce` is forwarded onto the injected `<script>` tag so
 *    it clears the strict policy.
 *  - Forms can obtain a handle via `ref` and call `reset()` after a
 *    failed submit. Cloudflare tokens are single-use: if the server
 *    rejects the first attempt for any reason, the widget still
 *    holds the now-consumed token and the next submit replays it,
 *    which siteverify rejects with `timeout-or-duplicate`. Resetting
 *    forces a fresh challenge so the user can retry cleanly.
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

/**
 * Imperative handle exposed by {@link TurnstileWidget} through its
 * `ref` prop. Kept minimal on purpose — anything beyond `reset()` is
 * either covered by the `onToken` callback or by forcing a remount
 * via a `key` prop.
 */
export interface TurnstileWidgetHandle {
  /**
   * Reset the widget so the next submit issues a fresh token.
   *
   * A no-op when the widget is not mounted (dev banner path,
   * script still loading, or `siteKey` missing).
   */
  reset(): void;
}

export interface TurnstileWidgetProps {
  /** Cloudflare Turnstile site key. Empty string / undefined → dev banner. */
  readonly siteKey: string | undefined;
  /** Invoked with the token string once the user clears the challenge. */
  readonly onToken: (token: string) => void;
  /** CSP nonce, forwarded onto the injected `<script>` tag. */
  readonly nonce: string;
  /** React 19 ref prop — opt-in handle for imperative controls. */
  readonly ref?: Ref<TurnstileWidgetHandle>;
}

/**
 * Inject the vendor script once per page. Returns a promise that
 * resolves when `window.turnstile` is available. Kept module-scoped
 * so every widget instance shares the same promise.
 */
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(nonce: string): Promise<void> {
  if (typeof window === 'undefined') {
    // SSR / Node — the widget never renders server-side, but the
    // Turnstile render is gated behind `useEffect` so this branch
    // is defensive only.
    return Promise.resolve();
  }
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
        existing.addEventListener('load', () => {
          resolve();
        });
        existing.addEventListener('error', () => {
          reject(new Error('Failed to load Turnstile script'));
        });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    if (nonce !== '') script.setAttribute('nonce', nonce);
    script.addEventListener('load', () => {
      resolve();
    });
    script.addEventListener('error', () => {
      reject(new Error('Failed to load Turnstile script'));
    });
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
  /**
   * `turnstile.render` returns the widget id that `turnstile.reset`
   * accepts. Stash it so the imperative handle can forward it.
   */
  const widgetIdRef = useRef<string | null>(null);
  // Stable ref so the effect and imperative handle always call the
  // latest `onToken` without listing it as a dependency (which would
  // tear down and remount the widget on every parent re-render).
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
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
        // `reset` invalidates the currently-held token; mirror
        // that on the React side so the form's submit guard
        // blocks until the user clears the fresh challenge.
        onTokenRef.current('');
      },
    }),
    [],
  );

  useEffect(() => {
    if (!keyConfigured) return;
    let cancelled = false;
    let localWidgetId: string | null = null;

    loadTurnstileScript(nonce)
      .then(() => {
        if (cancelled) return;
        const container = containerRef.current;
        if (container === null || window.turnstile === undefined) return;
        const id = window.turnstile.render(container, {
          sitekey: siteKey as string,
          // Cloudflare auto-refreshes expired tokens; keep
          // that on so a slow user never submits an
          // expired one.
          'refresh-expired': 'auto',
          callback: (token: string) => {
            onTokenRef.current(token);
          },
          'error-callback': () => {
            // Challenge failed to load / evaluate — drop
            // any stale token so the submit guard blocks.
            onTokenRef.current('');
          },
          'expired-callback': () => {
            // Cloudflare expires tokens after ~5 min.
            // Mirror on our side so the form re-asks.
            onTokenRef.current('');
            // Proactively ask Cloudflare to issue a fresh
            // token so the user doesn't have to click
            // "retry" on an expired challenge.
            if (
              typeof window !== 'undefined' &&
              window.turnstile !== undefined &&
              widgetIdRef.current !== null
            ) {
              try {
                window.turnstile.reset(widgetIdRef.current);
              } catch {
                // Widget already gone — ignore.
              }
            }
          },
          'timeout-callback': () => {
            // Challenge UI timed out before the user
            // solved it. Same cleanup + reset as expired.
            onTokenRef.current('');
            if (
              typeof window !== 'undefined' &&
              window.turnstile !== undefined &&
              widgetIdRef.current !== null
            ) {
              try {
                window.turnstile.reset(widgetIdRef.current);
              } catch {
                // Widget already gone — ignore.
              }
            }
          },
        });
        if (typeof id === 'string') {
          localWidgetId = id;
          widgetIdRef.current = id;
        }
      })
      .catch(() => {
        // Failure to load the script is surfaced to the caller
        // via an empty token state — the form submit guard
        // already blocks on "no token yet".
      });

    return () => {
      cancelled = true;
      // Remove the widget before unmount to prevent
      // "already rendered in this container" warnings on remount
      // (especially in React StrictMode where effects double-invoke).
      if (
        typeof window !== 'undefined' &&
        window.turnstile !== undefined &&
        localWidgetId !== null
      ) {
        window.turnstile.remove(localWidgetId);
        widgetIdRef.current = null;
      }
      // Drop any token captured by the destroyed widget so the
      // parent form's state goes back to "no token yet". Without
      // this reset a remount (StrictMode double-invoke, navigate
      // away & back to /login) keeps the stale `turnstileToken`
      // in React state and the next submit ships a token whose
      // widget no longer exists — Cloudflare then rejects with
      // `invalid-input-response`.
      onTokenRef.current('');
    };
  }, [keyConfigured, siteKey, nonce]);

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
