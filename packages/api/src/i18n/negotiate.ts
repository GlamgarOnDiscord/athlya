/**
 * Framework-free `Accept-Language` negotiation helper.
 *
 * Satisfies Requirement 28.2:
 *
 *   "WHEN a client sends an `Accept-Language` header, THE API_Gateway
 *    SHALL select the matching locale from the supported set and
 *    include the selected locale in error response `detail` fields."
 *
 * Why framework-free
 * ------------------
 * The Hono gateway (task 8.1) has not been scaffolded yet. Shipping
 * this as a pure helper lets the future middleware import it
 * unchanged, and keeps the logic testable without a running Worker
 * runtime.
 *
 * Algorithm (RFC 4647 "Lookup" filtering, lenient)
 * ------------------------------------------------
 *  1. Split the header on commas into entries.
 *  2. For each entry: split on `;`, take the first segment as the
 *     language tag, scan the remaining segments for a `q=<number>`
 *     parameter. A malformed or missing `q` defaults to `1`.
 *  3. Trim and lowercase the tag. Drop entries whose tag is empty
 *     or the wildcard `*` — the wildcard alone is handled by the
 *     top-level default fallback.
 *  4. Sort entries by `q` descending, breaking ties by source order
 *     (stable).
 *  5. For each surviving entry with `q > 0`, return the first
 *     `supported` locale that matches exactly, then the first one
 *     that matches by primary-language prefix (`fr-CA` → `fr`).
 *  6. If nothing matches, or the input is null / undefined / empty
 *     / `*` / malformed, return `options.default` (or
 *     {@link DEFAULT_LOCALE}).
 *
 * The parser is intentionally tiny and regex-free: the Accept-Language
 * grammar is simple enough that a hand-rolled split keeps the bundle
 * small and the behaviour auditable.
 */

/**
 * The locales Athlya ships MVP translations for, in priority order.
 *
 * Declared as a `readonly` tuple so the {@link Locale} type below
 * derives a string-literal union (`'fr' | 'en'`) that TypeScript can
 * discriminate on.
 */
export const SUPPORTED_LOCALES = ['fr', 'en'] as const;

/** Product default — French-first MVP launch. */
export const DEFAULT_LOCALE: Locale = 'fr';

/** Compile-time-checked union of supported locales. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Optional overrides accepted by {@link negotiateLocale}. */
export interface NegotiateLocaleOptions {
  /**
   * Override the supported locale list. Defaults to
   * {@link SUPPORTED_LOCALES}. Useful for tests and for downstream
   * services that ship a different bundle set.
   */
  supported?: readonly string[];

  /**
   * Override the fallback locale used when the header is absent,
   * malformed or lists no supported tag. Defaults to
   * {@link DEFAULT_LOCALE}.
   */
  default?: Locale;
}

/** Internal representation of one parsed Accept-Language entry. */
interface ParsedEntry {
  /** Lower-cased language tag, e.g. `'fr'`, `'en-us'`. */
  tag: string;
  /** Quality value in the closed interval [0, 1]. Defaults to 1. */
  q: number;
  /** Source position — used as a stable tie-breaker on equal `q`. */
  order: number;
}

/**
 * Parse a raw `Accept-Language` header into a list of well-formed
 * entries. Empty segments, the wildcard `*` and entries whose tag
 * cannot be read are silently dropped. Never throws.
 */
function parseAcceptLanguage(header: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const entries = header.split(',');

  for (let i = 0; i < entries.length; i++) {
    const rawEntry = entries[i];
    if (rawEntry === undefined) continue;
    const entry = rawEntry.trim();
    if (entry === '') continue;

    const parts = entry.split(';');
    const firstPart = parts[0];
    if (firstPart === undefined) continue;
    const tag = firstPart.trim().toLowerCase();
    if (tag === '' || tag === '*') continue;

    // Default q=1 per RFC 7231 §5.3.1. A malformed q= value
    // (e.g. `q=abc`) is treated leniently: we keep the default
    // rather than discarding the entry, so a single typo does not
    // silently drop an otherwise-acceptable language preference.
    let q = 1;
    for (let j = 1; j < parts.length; j++) {
      const rawParam = parts[j];
      if (rawParam === undefined) continue;
      const param = rawParam.trim();
      // Parameter keys are case-insensitive per the grammar, so
      // `q=` and `Q=` both mark a quality value.
      if (param.length < 2) continue;
      const keyChar = param.charAt(0);
      if ((keyChar !== 'q' && keyChar !== 'Q') || param.charAt(1) !== '=') {
        continue;
      }
      const qStr = param.slice(2).trim();
      const parsedQ = Number.parseFloat(qStr);
      if (Number.isFinite(parsedQ)) {
        // Clamp to the valid [0, 1] interval; out-of-range
        // values are a spec violation but we keep the intent
        // (positive → acceptable, non-positive → rejected).
        q = Math.min(1, Math.max(0, parsedQ));
      }
    }

    out.push({ tag, q, order: i });
  }

  return out;
}

/**
 * Select the best-matching locale from {@link SUPPORTED_LOCALES} (or
 * the caller-provided list) for a given `Accept-Language` header.
 *
 * The function is total: it always returns a locale, falling back to
 * `options.default` (or {@link DEFAULT_LOCALE}) on every failure
 * mode. It never throws.
 *
 * @param header  The raw `Accept-Language` header value. `null`,
 *                `undefined`, `''` and `'*'` all trigger the fallback.
 * @param options Optional overrides for `supported` and `default`.
 * @returns       The chosen locale.
 *
 * Note on typing: `supported` is loosely typed as `readonly string[]`
 * to let callers negotiate against a custom set (e.g. a downstream
 * service that ships German). The return type stays {@link Locale}
 * for ergonomic use with the MVP bundle; when a wider list is passed
 * the caller is responsible for narrowing the result.
 */
export function negotiateLocale(
  header: string | null | undefined,
  options?: NegotiateLocaleOptions,
): Locale {
  const supported = options?.supported ?? SUPPORTED_LOCALES;
  const fallback = options?.default ?? DEFAULT_LOCALE;

  if (header === null || header === undefined) return fallback;
  const trimmed = header.trim();
  if (trimmed === '' || trimmed === '*') return fallback;

  const parsed = parseAcceptLanguage(trimmed);
  if (parsed.length === 0) return fallback;

  // Sort by q descending; ties broken by original source order
  // (stable). `Array.prototype.sort` is stable since ES2019, so the
  // explicit `order` comparison is mostly defensive — it keeps the
  // intent legible and makes the tie-breaker independent of the
  // engine's sort implementation.
  parsed.sort((a, b) => {
    if (a.q !== b.q) return b.q - a.q;
    return a.order - b.order;
  });

  // Pre-lower the supported list once so the hot loop below does
  // one `indexOf` per candidate instead of one per character.
  const supportedLower = supported.map((s) => s.toLowerCase());

  for (const { tag, q } of parsed) {
    // `q=0` is the RFC-defined way to say "not acceptable" — we
    // must skip such entries even if the tag is in the supported
    // list.
    if (q <= 0) continue;

    // Exact match wins over prefix match.
    const exactIndex = supportedLower.indexOf(tag);
    if (exactIndex >= 0) {
      const hit = supported[exactIndex];
      if (hit !== undefined) return hit as Locale;
    }

    // Prefix match: strip any region / script / extension subtag
    // and retry. `fr-CA`, `fr-Latn-CA`, `zh-Hant-TW` all collapse
    // to their primary language subtag here.
    const dashIndex = tag.indexOf('-');
    if (dashIndex > 0) {
      const primary = tag.slice(0, dashIndex);
      const primaryIndex = supportedLower.indexOf(primary);
      if (primaryIndex >= 0) {
        const hit = supported[primaryIndex];
        if (hit !== undefined) return hit as Locale;
      }
    }
  }

  return fallback;
}

/**
 * Render a Problem Details-friendly fragment announcing the selected
 * locale, e.g. `'Locale: fr'`.
 *
 * The Problem Details middleware (task 8.5) appends this to the
 * `detail` field so clients can confirm which bundle the server used
 * to localise the error message. Keeping the format in a named helper
 * lets every error path stay consistent without duplicating the
 * string across modules.
 */
export function formatProblemDetailLocale(locale: Locale): string {
  return `Locale: ${locale}`;
}
