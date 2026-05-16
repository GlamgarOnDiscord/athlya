/**
 * Login anomaly detector.
 *
 * Sprint 12 / Slice 12.8 (Epic B3.4) — compares the current login
 * IP-derived country and UA family against the user's last known
 * login, returning a non-null result when either dimension changed
 * so the caller can publish `auth.suspicious.login.anomaly`.
 *
 * Design notes
 * ------------
 *
 *   • **Country signal** — Cloudflare populates `CF-IPCountry` on
 *     every Worker request (ISO-3166 alpha-2). Dev environments
 *     without Cloudflare set it to `'XX'` ("undetermined"). We
 *     skip detection when current OR previous is `XX` to avoid
 *     emitting noise from local dev.
 *
 *   • **UA family signal** — coarse-grained classification from
 *     `User-Agent` substrings. Six buckets (chrome, firefox,
 *     safari, edge, mobile, bot) plus a fallback `other`. Finer
 *     fingerprinting (exact version, OS) would have a much higher
 *     false-positive rate (auto-updates would trigger every week)
 *     and is left for a later iteration.
 *
 *   • **Storage** — the caller (auth service) owns the persistence.
 *     This module exposes pure helpers; the redis adapter is in
 *     `@athlya/api` so it can share the existing `getOrCreateRedis`
 *     cache.
 *
 *   • **First-time signal** — when the user has no previous login
 *     stamp, the detector returns `null` (no anomaly). The first
 *     login becomes the baseline.
 *
 *   • **Privacy** — the comparison artefacts (country, ua family)
 *     are coarse and PII-light. Full IP and UA strings flow into
 *     the audit log via `actorId` correlation, not through this
 *     event.
 */

/** Coarse UA family bucket. */
export type UaFamily =
    | 'chrome'
    | 'firefox'
    | 'safari'
    | 'edge'
    | 'mobile'
    | 'bot'
    | 'other';

/** Snapshot of the last known login signal. */
export interface LoginSignal {
    readonly country: string;
    readonly uaFamily: UaFamily;
}

/** Result of {@link detectLoginAnomaly}. */
export interface LoginAnomaly {
    /** Coarse UA family, current request. */
    readonly uaFamily: UaFamily;
    /** ISO-3166 alpha-2 country, current request. */
    readonly country: string;
    /** UA family of the previous login. `null` on first ever. */
    readonly previousUaFamily: UaFamily | null;
    /** Country of the previous login. `null` on first ever. */
    readonly previousCountry: string | null;
}

/**
 * Coarse UA family classifier. Pure function — given a User-Agent
 * string, return one of six buckets + `'other'` fallback. The order
 * of checks matters: Edge contains "Chrome" in its UA, mobile UAs
 * contain "Safari", etc. We test the more specific tokens first.
 */
export function classifyUserAgent(ua: string | undefined): UaFamily {
    if (typeof ua !== 'string' || ua === '') return 'other';
    const s = ua.toLowerCase();

    // Bot signatures first — overlap-free with browser checks.
    if (
        s.includes('bot') ||
        s.includes('crawl') ||
        s.includes('spider') ||
        s.includes('curl/') ||
        s.includes('wget/') ||
        s.includes('python-requests') ||
        s.includes('postman')
    ) {
        return 'bot';
    }

    // Mobile detection BEFORE browser families — a mobile Chrome
    // is best classified as `'mobile'` for anomaly purposes.
    if (
        s.includes('iphone') ||
        s.includes('ipad') ||
        s.includes('android') ||
        s.includes('mobile')
    ) {
        return 'mobile';
    }

    // Edge BEFORE Chrome — Edge UAs contain `Chrome/` for compat.
    if (s.includes('edg/') || s.includes('edge/')) return 'edge';
    if (s.includes('firefox/')) return 'firefox';
    // Chrome BEFORE Safari — Chrome UAs contain `Safari/`.
    if (s.includes('chrome/')) return 'chrome';
    if (s.includes('safari/')) return 'safari';

    return 'other';
}

/** Options accepted by {@link detectLoginAnomaly}. */
export interface DetectLoginAnomalyInput {
    /** Current request country (Cloudflare `CF-IPCountry`). */
    readonly currentCountry: string | undefined;
    /** Current request User-Agent. */
    readonly currentUserAgent: string | undefined;
    /** Last persisted signal — `null` on first login ever. */
    readonly previous: LoginSignal | null;
}

/**
 * Decide whether the current login should fire
 * `auth.suspicious.login.anomaly`.
 *
 * Returns:
 *   - `null` when there is no anomaly (first login, or both
 *     dimensions match the previous signal, or one side is the
 *     dev-mode `'XX'` placeholder).
 *   - A {@link LoginAnomaly} record carrying both sides of the
 *     comparison when either dimension changed.
 */
export function detectLoginAnomaly(
    input: DetectLoginAnomalyInput,
): LoginAnomaly | null {
    const country = normaliseCountry(input.currentCountry);
    const uaFamily = classifyUserAgent(input.currentUserAgent);

    // First login ever — no baseline. The caller stores the signal
    // so the next call has something to compare against.
    if (input.previous === null) {
        return null;
    }

    // Skip detection when either side is the undetermined
    // placeholder. `'XX'` is what Cloudflare emits when the IP is
    // private, on a dev runtime, or in a country it cannot resolve.
    // Treating that as a country change would generate noise on
    // every staging deploy.
    if (country === 'XX' || input.previous.country === 'XX') {
        return null;
    }

    const countryChanged = country !== input.previous.country;
    const uaChanged = uaFamily !== input.previous.uaFamily;

    if (!countryChanged && !uaChanged) return null;

    return {
        country,
        uaFamily,
        previousCountry: input.previous.country,
        previousUaFamily: input.previous.uaFamily,
    };
}

/**
 * Normalise a Cloudflare `CF-IPCountry` value to ISO-3166 alpha-2
 * upper-case, with `'XX'` as the fallback when the input is
 * missing/malformed.
 */
function normaliseCountry(value: string | undefined): string {
    if (typeof value !== 'string') return 'XX';
    const trimmed = value.trim().toUpperCase();
    if (trimmed.length !== 2) return 'XX';
    if (!/^[A-Z]{2}$/u.test(trimmed)) return 'XX';
    return trimmed;
}
