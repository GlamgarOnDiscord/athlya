/**
 * Analytics consent storage — Sprint-6 Slice 6.1 (Vague 34, audit
 * finding S5-009).
 *
 * As of Vague 33, no third-party analytics SDK is loaded by the
 * web app, so the cookie banner is preventive: it documents the
 * consent state in `localStorage` and exposes the helpers downstream
 * components will consume the moment a Plausible / PostHog / Sentry
 * Browser SDK lands.
 *
 * The audit (S5-009) was explicit: a banner MUST exist BEFORE the
 * first SDK is added. Wiring the storage layer + the banner now
 * means the moment a developer adds an analytics import, they have
 * a `useAnalyticsConsent()` hook ready to gate the SDK init behind
 * `consent.analytics === true`.
 *
 * Storage shape
 * -------------
 * `localStorage['athlya.analytics-consent.v1']` holds a JSON
 * serialised {@link AnalyticsConsent} record. Versioned key so a
 * future schema change (adding new categories) can migrate cleanly
 * without tripping older builds.
 *
 * The record is NOT sent to the server — analytics consent lives
 * purely client-side because the only consumer is the SDK init
 * branch in the browser. The user's broader consents (marketing /
 * thirdParty) are still tracked server-side via
 * `users.consents.{marketing,thirdParty}` for legal record-keeping.
 *
 * The banner respects ePrivacy (CNIL doctrine "Cookies et autres
 * traceurs") :
 *   - No SDK loads BEFORE explicit acceptance.
 *   - Refusal is as easy as acceptance (single click each).
 *   - The choice persists 13 months (CNIL recommendation).
 */

/**
 * Versioned storage key. Bump on schema changes (e.g. adding a
 * `socialMedia` category) so old payloads do not collide with the
 * new shape.
 */
const ANALYTICS_CONSENT_KEY = 'athlya.analytics-consent.v1';

/**
 * 13 months in milliseconds — CNIL doctrine maximum durée du
 * consentement. Past this window we re-prompt the user.
 */
const ANALYTICS_CONSENT_TTL_MS = 13 * 30 * 24 * 60 * 60 * 1000;

/**
 * Snapshot of the user's consent for client-side analytics.
 *
 * `analytics`     — anonymised audience measurement (Plausible).
 * `errorTracking` — Sentry browser SDK (full DSN URL collection,
 *                   includes user-agent and stack trace).
 * `acceptedAt`    — ISO-8601 of the choice. Used to compute the
 *                   13-month re-prompt window.
 */
export interface AnalyticsConsent {
  readonly analytics: boolean;
  readonly errorTracking: boolean;
  readonly acceptedAt: string;
}

/**
 * Default consent posture before the user has chosen — strict
 * refusal of every category. The banner then prompts; until the
 * user acts, every analytics-gated SDK MUST stay un-initialised.
 */
export const DEFAULT_CONSENT: AnalyticsConsent = {
  analytics: false,
  errorTracking: false,
  acceptedAt: '1970-01-01T00:00:00.000Z',
};

/**
 * Read the persisted consent record from `localStorage`. Returns
 * the default (all-false) record when:
 *   - The browser has no stored value (first visit).
 *   - The stored value is malformed (forward-compat with future
 *     schema bumps that didn't migrate).
 *   - The 13-month window has elapsed (CNIL re-prompt).
 *   - We're SSR-rendering (no `window`).
 */
export function readAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === 'undefined') return DEFAULT_CONSENT;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ANALYTICS_CONSENT_KEY);
  } catch {
    // Privacy-mode browsers throw on `localStorage` access — the
    // fail-safe posture is to assume no consent.
    return DEFAULT_CONSENT;
  }
  if (raw === null) return DEFAULT_CONSENT;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsConsent>;
    if (
      typeof parsed.analytics !== 'boolean' ||
      typeof parsed.errorTracking !== 'boolean' ||
      typeof parsed.acceptedAt !== 'string'
    ) {
      return DEFAULT_CONSENT;
    }
    const acceptedAtMs = Date.parse(parsed.acceptedAt);
    if (Number.isNaN(acceptedAtMs) || Date.now() - acceptedAtMs > ANALYTICS_CONSENT_TTL_MS) {
      return DEFAULT_CONSENT;
    }
    return {
      analytics: parsed.analytics,
      errorTracking: parsed.errorTracking,
      acceptedAt: parsed.acceptedAt,
    };
  } catch {
    return DEFAULT_CONSENT;
  }
}

/**
 * Persist the user's consent decision. Stamps `acceptedAt` to
 * `now()` so the 13-month TTL is anchored on the moment of choice,
 * not the moment of first visit.
 */
export function writeAnalyticsConsent(
  consent: Pick<AnalyticsConsent, 'analytics' | 'errorTracking'>,
): AnalyticsConsent {
  const stamped: AnalyticsConsent = {
    analytics: consent.analytics,
    errorTracking: consent.errorTracking,
    acceptedAt: new Date().toISOString(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, JSON.stringify(stamped));
    } catch {
      // Privacy-mode browsers — silently swallow. The in-
      // memory state held by `<CookieBanner />` is the
      // source of truth for the current page lifetime.
    }
  }
  return stamped;
}

/**
 * Returns `true` when the user has not yet made a choice (or the
 * choice has expired). Used by `<CookieBanner />` to decide whether
 * to render the banner UI.
 */
export function shouldPromptForConsent(): boolean {
  if (typeof window === 'undefined') return false;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ANALYTICS_CONSENT_KEY);
  } catch {
    return false;
  }
  if (raw === null) return true;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsConsent>;
    if (typeof parsed.acceptedAt !== 'string') return true;
    const acceptedAtMs = Date.parse(parsed.acceptedAt);
    if (Number.isNaN(acceptedAtMs)) return true;
    return Date.now() - acceptedAtMs > ANALYTICS_CONSENT_TTL_MS;
  } catch {
    return true;
  }
}
