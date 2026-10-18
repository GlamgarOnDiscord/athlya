/**
 * Cloudflare Turnstile for the native sign-in and registration screens
 * (issue #649, Requirement 26.1).
 *
 * The API serves `GET /v1/auth/turnstile-challenge`, a page that runs the
 * real Turnstile widget. The app loads it in a WebView and receives the
 * widget events as JSON messages; the token goes out in the same
 * `cf-turnstile-token` header the web client uses, and the API verifies
 * it with siteverify exactly as for the web.
 *
 * Everything here is platform-free so it is unit-tested in Node; the
 * WebView itself lives in `components/TurnstileChallenge.tsx`.
 */
import { z } from 'zod';

import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-token';

export const TURNSTILE_CHALLENGE_PATH = '/v1/auth/turnstile-challenge';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export type ChallengeTheme = 'light' | 'dark';

export function challengeUrl(apiBaseUrl: string, locale: Locale, theme: ChallengeTheme): string {
  const url = new URL(TURNSTILE_CHALLENGE_PATH, apiBaseUrl);
  url.searchParams.set('lang', locale);
  url.searchParams.set('theme', theme);
  return url.toString();
}

const ChallengeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('token'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('expired') }),
  z.object({ type: z.literal('timeout') }),
  z.object({ type: z.literal('error'), code: z.string().max(64) }),
]);

export type ChallengeEvent =
  | z.infer<typeof ChallengeMessageSchema>
  /** The page itself could not be loaded (offline, HTTP error, misconfigured API). */
  | { readonly type: 'load-failed' }
  /** A new challenge starts (retry, or after a submit consumed the token). */
  | { readonly type: 'reset' };

/** True when `url` is the challenge page served by this app's API origin. */
export function isChallengePage(url: string, apiBaseUrl: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === new URL(apiBaseUrl).origin && parsed.pathname === TURNSTILE_CHALLENGE_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Parses a message posted by the WebView. Messages from any other page
 * than the API's challenge page, or with an unexpected shape, are dropped.
 */
export function parseChallengeMessage(
  data: string,
  pageUrl: string,
  apiBaseUrl: string,
): ChallengeEvent | null {
  if (!isChallengePage(pageUrl, apiBaseUrl)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = ChallengeMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Navigation the WebView may perform: the challenge page itself and
 * Cloudflare's challenge frames. Anything else (Turnstile's privacy and
 * help links) is opened in the system browser instead.
 */
export function isAllowedNavigation(url: string, apiBaseUrl: string): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  if (isChallengePage(url, apiBaseUrl)) return true;
  try {
    return new URL(url).origin === TURNSTILE_ORIGIN;
  } catch {
    return false;
  }
}

/** True for a link the user may open in the system browser. */
export function isExternalLink(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export type ChallengeState =
  | { readonly status: 'loading' }
  | { readonly status: 'pending' }
  | { readonly status: 'verified'; readonly token: string }
  | { readonly status: 'expired' }
  | { readonly status: 'failed' };

export const INITIAL_CHALLENGE_STATE: ChallengeState = { status: 'loading' };

/**
 * Turnstile refreshes an expired token by itself (`refresh-expired: auto`)
 * and posts a new `token` message, so `expired` only clears the token.
 * Errors, timeouts and a page that does not load end in `failed`, which
 * the screen turns into a retry button (the widget does not retry on its
 * own: `retry: never`).
 */
export function reduceChallenge(state: ChallengeState, event: ChallengeEvent): ChallengeState {
  switch (event.type) {
    case 'reset':
      return INITIAL_CHALLENGE_STATE;
    case 'ready':
      return state.status === 'loading' ? { status: 'pending' } : state;
    case 'token':
      return { status: 'verified', token: event.token };
    case 'expired':
      return { status: 'expired' };
    case 'timeout':
    case 'error':
    case 'load-failed':
      return { status: 'failed' };
  }
}

export function challengeToken(state: ChallengeState): string | null {
  return state.status === 'verified' ? state.token : null;
}

export interface ChallengeNotice {
  readonly key: TranslationKeys;
  readonly tone: 'info' | 'error';
  readonly retry: boolean;
}

export function challengeNotice(state: ChallengeState): ChallengeNotice {
  switch (state.status) {
    case 'loading':
    case 'pending':
      return { key: 'mobile.auth.turnstile.pending', tone: 'info', retry: false };
    case 'verified':
      return { key: 'mobile.auth.turnstile.verified', tone: 'info', retry: false };
    case 'expired':
      return { key: 'mobile.auth.turnstile.expired', tone: 'info', retry: false };
    case 'failed':
      return { key: 'mobile.auth.turnstile.failed', tone: 'error', retry: true };
  }
}
