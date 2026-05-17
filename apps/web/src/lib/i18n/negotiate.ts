/**
 * `Accept-Language` negotiation helper — web-app copy.
 *
 * Satisfies Requirement 28.2 on the Next.js edge (Req 28.2 originally
 * targets the Hono API gateway; the same RFC-compliant lookup applies
 * client-side in the Next 16 proxy so the two surfaces agree on the
 * selected locale for a given request).
 *
 * Why inline, not imported from `@athlya/api`
 * ------------------------------------------
 * The task brief explicitly forbids taking a `@athlya/api` runtime
 * dependency from `@athlya/web` (bundler + tenant-blast-radius). The
 * function is small and side-effect-free, so copying it here keeps
 * Turbopack happy and avoids pulling the edge-Worker surface into the
 * web app.
 *
 * Algorithm summary (RFC 4647 lookup, lenient)
 * --------------------------------------------
 *  1. Split the raw header on commas.
 *  2. Parse each entry into a `{ tag, q }` pair — default `q = 1`,
 *     malformed `q=` values recover to 1 instead of dropping the tag.
 *  3. Discard empty tags and the wildcard `*`; they trigger the
 *     caller-provided fallback at the end of the function.
 *  4. Sort by `q` descending (stable tie-breaker on source order).
 *  5. For each acceptable entry (`q > 0`), return the first supported
 *     locale that matches exactly, then the first one that matches by
 *     primary-language prefix (`fr-CA` → `fr`).
 *  6. On every failure mode — `null`, `undefined`, `''`, `'*'`,
 *     all-malformed, no overlap — return `fallback`.
 *
 * The function is total and never throws.
 *
 * The signature uses the positional `(header, supported, fallback)`
 * form called from `src/proxy.ts` (see task 10.6). This deliberately
 * differs from the object-options form exported by
 * `packages/api/src/i18n/negotiate.ts` because the web-app surface
 * only needs the minimal positional shape.
 *
 * @see packages/api/src/i18n/negotiate.ts — canonical edge-gateway copy.
 * @see Requirement 28.2 — locale selection from Accept-Language.
 */

/** Internal representation of one parsed Accept-Language entry. */
interface ParsedEntry {
  /** Lower-cased language tag, e.g. `'fr'`, `'en-us'`. */
  readonly tag: string;
  /** Quality value clamped to `[0, 1]`. Defaults to 1. */
  readonly q: number;
  /** Source position — stable tie-breaker on equal `q`. */
  readonly order: number;
}

/**
 * Parse a raw `Accept-Language` header into a list of entries.
 *
 * Empty segments, the wildcard `*` and entries whose tag cannot be
 * read are silently dropped. Never throws.
 */
function parseAcceptLanguage(header: string): readonly ParsedEntry[] {
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

    // Default q=1 per RFC 7231 §5.3.1. A malformed q= value is
    // treated leniently: keep the default rather than drop the
    // entry, so a single typo does not silently lose an otherwise
    // acceptable language preference.
    let q = 1;
    for (let j = 1; j < parts.length; j++) {
      const rawParam = parts[j];
      if (rawParam === undefined) continue;
      const param = rawParam.trim();
      if (param.length < 2) continue;
      const keyChar = param.charAt(0);
      if ((keyChar !== 'q' && keyChar !== 'Q') || param.charAt(1) !== '=') {
        continue;
      }
      const qStr = param.slice(2).trim();
      const parsedQ = Number.parseFloat(qStr);
      if (Number.isFinite(parsedQ)) {
        q = Math.min(1, Math.max(0, parsedQ));
      }
    }

    out.push({ tag, q, order: i });
  }

  return out;
}

/**
 * Select the best-matching locale from `supported` for a given
 * `Accept-Language` header.
 *
 * The function is total: it always returns a value, falling back to
 * `fallback` on every failure mode. It never throws.
 *
 * @param header    The raw `Accept-Language` header value. `null`,
 *                  `undefined`, `''` and `'*'` all trigger the fallback.
 * @param supported The locales the caller ships bundles for, in priority
 *                  order (e.g. `['fr', 'en']`). Compared case-insensitively.
 * @param fallback  The locale returned when no supported tag is listed
 *                  or the header is absent / malformed.
 * @returns         The chosen locale — guaranteed to be either a member
 *                  of `supported` or `fallback`.
 */
export function negotiateLocale<L extends string>(
  header: string | null | undefined,
  supported: readonly L[],
  fallback: L,
): L {
  if (header === null || header === undefined) return fallback;
  const trimmed = header.trim();
  if (trimmed === '' || trimmed === '*') return fallback;

  const parsed = parseAcceptLanguage(trimmed);
  if (parsed.length === 0) return fallback;

  // Sort by q descending; stable source-order tie-break.
  const sorted = parsed.toSorted((a, b) => {
    if (a.q !== b.q) return b.q - a.q;
    return a.order - b.order;
  });

  // Map lower-cased tag → original-case locale for O(1) lookups.
  const lowerToSupported = new Map(supported.map((s) => [s.toLowerCase(), s]));

  for (const { tag, q } of sorted) {
    // `q=0` is the RFC-defined way to say "not acceptable" — skip
    // even if the tag itself would match.
    if (q <= 0) continue;

    // Exact match wins over prefix match.
    const exact = lowerToSupported.get(tag);
    if (exact !== undefined) return exact;

    // Prefix match: collapse region / script / extension subtags
    // and retry. `fr-CA`, `fr-Latn-CA`, `zh-Hant-TW` all fall
    // back to their primary language here.
    const primary = tag.split('-')[0] ?? tag;
    if (primary !== tag) {
      const prefix = lowerToSupported.get(primary);
      if (prefix !== undefined) return prefix;
    }
  }

  return fallback;
}
