/**
 * `GET /v1/auth/turnstile-challenge` — Cloudflare Turnstile page for the
 * native mobile app (issue #649).
 *
 * A native app has no DOM, so the app loads this page in a WebView,
 * the real Turnstile widget runs in it, and the token is handed to the
 * app through `window.ReactNativeWebView.postMessage`. The app then
 * sends it in the `cf-turnstile-token` header exactly like the web
 * client, and the `turnstile()` middleware verifies it with siteverify:
 * server-side verification is unchanged.
 *
 * Cloudflare documents this WebView integration:
 * https://developers.cloudflare.com/turnstile/get-started/mobile-implementation
 *
 * The page only carries the public site key (`TURNSTILE_SITE_KEY`).
 * Its CSP allows scripts, frames and connections to
 * `challenges.cloudflare.com` only, plus the page's own inline script
 * and style through a per-response nonce. The API hostname that serves
 * the page must be listed in the widget's allowed hostnames, otherwise
 * the widget fails with error 110200.
 *
 * Messages posted to the app (JSON strings):
 *
 *   { "type": "ready" }                    widget rendered
 *   { "type": "token", "token": "…" }      challenge solved
 *   { "type": "expired" }                  token expired, widget refreshes it
 *   { "type": "timeout" }                  interactive challenge timed out
 *   { "type": "error", "code": "…" }       widget or script failure
 */

import type { HonoEnv } from '../types.js';
import type { Context } from 'hono';

/** Cloudflare's always-pass test site key, used only when `ENVIRONMENT=dev` has no key. */
export const TURNSTILE_DEV_TEST_SITE_KEY = '1x00000000000000000000AA';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Mount path of the challenge page; the auth IP limiter skips it (see `base-app.ts`). */
export const TURNSTILE_CHALLENGE_PATH = '/v1/auth/turnstile-challenge';

const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** Site keys are short base62-like identifiers; anything else is a misconfiguration. */
const SITE_KEY_PATTERN = /^[0-9A-Za-z_-]{1,128}$/u;

export type ChallengeLocale = 'fr' | 'en';
export type ChallengeTheme = 'auto' | 'light' | 'dark';

const TITLES: Readonly<Record<ChallengeLocale, string>> = {
  fr: 'Vérification de sécurité',
  en: 'Security check',
};

const NOSCRIPT: Readonly<Record<ChallengeLocale, string>> = {
  fr: 'JavaScript est nécessaire pour la vérification de sécurité.',
  en: 'JavaScript is required for the security check.',
};

export function parseChallengeLocale(raw: string | undefined): ChallengeLocale {
  return raw === 'en' ? 'en' : 'fr';
}

export function parseChallengeTheme(raw: string | undefined): ChallengeTheme {
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

export function isValidSiteKey(siteKey: string): boolean {
  return SITE_KEY_PATTERN.test(siteKey);
}

/** Base64 of 16 random bytes: a fresh CSP nonce per response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildChallengeCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `style-src 'nonce-${nonce}'`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `connect-src ${TURNSTILE_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const PAGE_SCRIPT = `(function () {
  var host = document.getElementById('challenge');
  function send(message) {
    var bridge = window.ReactNativeWebView;
    if (bridge && typeof bridge.postMessage === 'function') {
      bridge.postMessage(JSON.stringify(message));
    }
  }
  function render() {
    if (!window.turnstile) {
      send({ type: 'error', code: 'script_unavailable' });
      return;
    }
    window.turnstile.render(host, {
      sitekey: host.getAttribute('data-site-key'),
      language: host.getAttribute('data-language'),
      theme: host.getAttribute('data-theme'),
      size: 'flexible',
      retry: 'never',
      'refresh-expired': 'auto',
      'refresh-timeout': 'auto',
      callback: function (token) { send({ type: 'token', token: token }); },
      'expired-callback': function () { send({ type: 'expired' }); },
      'timeout-callback': function () { send({ type: 'timeout' }); },
      'error-callback': function (code) { send({ type: 'error', code: String(code) }); return true; },
      'unsupported-callback': function () { send({ type: 'error', code: 'unsupported' }); }
    });
    send({ type: 'ready' });
  }
  var script = document.createElement('script');
  script.src = '${TURNSTILE_SCRIPT_URL}';
  script.async = true;
  script.addEventListener('load', render);
  script.addEventListener('error', function () { send({ type: 'error', code: 'script_load' }); });
  document.head.appendChild(script);
})();`;

const PAGE_STYLE = `:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: system-ui, sans-serif; }
#challenge { width: 100%; }`;

export interface ChallengePageInput {
  readonly siteKey: string;
  readonly nonce: string;
  readonly locale: ChallengeLocale;
  readonly theme: ChallengeTheme;
}

/**
 * Render the challenge page. `siteKey` must pass {@link isValidSiteKey};
 * every other interpolated value comes from a fixed allowlist or from
 * {@link createNonce}, so nothing needs HTML escaping.
 */
export function renderChallengePage(input: ChallengePageInput): string {
  if (!isValidSiteKey(input.siteKey)) throw new Error('invalid Turnstile site key');
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${TITLES[input.locale]}</title>
<style nonce="${input.nonce}">${PAGE_STYLE}</style>
</head>
<body>
<main>
<div id="challenge" data-site-key="${input.siteKey}" data-language="${input.locale}" data-theme="${input.theme}"></div>
<noscript>${NOSCRIPT[input.locale]}</noscript>
</main>
<script nonce="${input.nonce}">${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Site key for this environment: `TURNSTILE_SITE_KEY`, or Cloudflare's
 * test key in `dev` (where the `turnstile()` middleware skips siteverify
 * without a secret). `null` means the deployment is misconfigured.
 */
export function resolveSiteKey(env: {
  readonly ENVIRONMENT: string;
  readonly TURNSTILE_SITE_KEY?: string;
}): string | null {
  const configured = env.TURNSTILE_SITE_KEY?.trim() ?? '';
  if (configured !== '') return isValidSiteKey(configured) ? configured : null;
  return env.ENVIRONMENT === 'dev' ? TURNSTILE_DEV_TEST_SITE_KEY : null;
}

export function turnstileChallengeHandler(c: Context<HonoEnv>): Response {
  const siteKey = resolveSiteKey(c.env);
  if (siteKey === null) {
    const traceId = c.get('traceId');
    c.get('logger').error('turnstile site key missing or invalid', {
      environment: c.env.ENVIRONMENT,
    });
    return c.body(
      JSON.stringify({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        traceId,
        code: 'configuration_error',
      }),
      500,
      { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    );
  }

  const nonce = createNonce();
  const html = renderChallengePage({
    siteKey,
    nonce,
    locale: parseChallengeLocale(c.req.query('lang')),
    theme: parseChallengeTheme(c.req.query('theme')),
  });
  return c.body(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': buildChallengeCsp(nonce),
    'cache-control': 'no-store',
  });
}
