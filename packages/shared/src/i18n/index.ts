/**
 * Athlya i18n helper — a dependency-free, compile-time-typed translation
 * resolver backed by two JSON bundles (`fr`, `en`).
 *
 * Design intent:
 *  - French is the product default; English is the guaranteed fallback.
 *  - Keys are expressed as dotted paths (`"auth.login.title"`) and typed
 *    against the English bundle so IDEs and `tsc` catch typos at build time.
 *  - The helper never throws: a missing key falls back to English, then to
 *    the key itself, with a `console.warn` in non-production builds so it's
 *    visible in dev without breaking users in prod.
 *  - Placeholders of the form `{name}` are replaced by the optional
 *    `values` argument. A placeholder whose key is not in `values` is left
 *    untouched so upstream UI can render `"Waitlist position: {position}"`
 *    in tooling previews without crashing.
 *
 * Usage:
 * ```ts
 * import { t, createTranslator } from '@athlya/shared/i18n';
 *
 * t('auth.login.submit');                                  // French by default
 * t('auth.login.submit', 'en');                            // English
 * t('reservations.waitlistPosition', 'fr', { position: 3 }); // interpolation
 * const tr = createTranslator('en');                       // bound translator for the request
 * tr('reservations.confirmed');
 * tr('reservations.waitlistPosition', { position: 3 });
 * ```
 */
// Import attributes keep this compatible with modern Node, bundlers and
// edge runtimes, and TypeScript resolves the JSON modules via
// `resolveJsonModule: true` in the base tsconfig.
import en from './en.json' with { type: 'json' };
import fr from './fr.json' with { type: 'json' };

/**
 * The set of locales the platform ships MVP bundles for. Adding a new locale
 * means adding a file here and extending this union — callers get a compile
 * error anywhere the `Locale` type is used.
 */
export type Locale = 'fr' | 'en';

/** Product default locale — French. */
export const defaultLocale: Locale = 'fr';

/** Guaranteed fallback locale — English. Must be complete at all times. */
export const fallbackLocale: Locale = 'en';

/**
 * Raw JSON bundles exposed for server-side use (e.g. SSR, static extraction,
 * Tailwind plugin pipelines). Consumers that only need to resolve a key at
 * runtime should use {@link t} or {@link createTranslator} instead.
 */
export const bundles = { fr, en } as const;

/** Shape of the English bundle, inferred from the JSON import. */
export type TranslationBundle = typeof en;

/**
 * Recursive helper that collects every dotted leaf path of a nested object.
 *
 * The depth counter (`D`) is capped at 6 levels, which comfortably covers
 * the MVP namespaces (`auth.login.submit`, `reservations.waitlistPosition`,
 * …) while keeping TypeScript instantiation well under the recursion limit.
 */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6];

type DotPath<T, D extends number = 6> = [D] extends [never]
    ? never
    : T extends string
    ? ''
    : T extends object
    ? {
        [K in keyof T & string]: T[K] extends string
        ? K
        : `${K}.${DotPath<T[K], Prev[D]>}`;
    }[keyof T & string]
    : never;

/**
 * Every valid dotted translation key, derived from the English bundle.
 *
 * English is the source of truth because the fallback chain guarantees every
 * rendered string flows through it. Adding a key to `en.json` without
 * adding it to `fr.json` will still type-check; the runtime helper logs a
 * warning in dev when a French translation is missing.
 */
export type TranslationKeys = DotPath<TranslationBundle>;

/** Internal — walk a dotted path against a JSON bundle. */
function resolvePath(bundle: unknown, key: string): string | undefined {
    const segments = key.split('.');
    let cursor: unknown = bundle;
    for (const segment of segments) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return typeof cursor === 'string' ? cursor : undefined;
}

/** True only when we are confident we're running a production build. */
function isProduction(): boolean {
    try {
        // `process` may be undefined in edge / browser runtimes; guard defensively.
        return typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
    } catch {
        return false;
    }
}

/**
 * Placeholder values accepted by {@link t} and {@link createTranslator}.
 *
 * The shape mirrors `Intl.MessageFormat` inputs without the runtime
 * dependency: a flat record whose keys match `{name}` markers inside a
 * translation string. Values that render as `string` (via `String(value)`)
 * are supported; `undefined` / `null` are coerced to the empty string so
 * a missing counter reads as `"Waitlist position: "` rather than
 * `"Waitlist position: undefined"`.
 */
export type InterpolationValues = Readonly<Record<string, string | number | bigint | boolean | null | undefined>>;

/**
 * Replace every `{name}` marker in `input` with the matching entry from
 * `values`. Markers whose key is missing from `values` are left intact so
 * tooling can surface the untranslated variable for debugging.
 */
function interpolate(input: string, values: InterpolationValues | undefined): string {
    if (values === undefined) return input;
    return input.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, rawKey: string) => {
        if (!Object.prototype.hasOwnProperty.call(values, rawKey)) return match;
        const raw = values[rawKey];
        if (raw === undefined || raw === null) return '';
        return String(raw);
    });
}

/**
 * Resolve a translation key for a given locale, falling back to English and
 * finally to the key itself if no bundle has a value.
 *
 * Never throws. In non-production environments, warns once per missing key
 * occurrence so translation gaps surface during development.
 *
 * When `values` is provided, every `{name}` marker in the resolved string
 * is replaced with `values[name]`. Markers whose key is absent from
 * `values` are left intact to make missing placeholders visible in dev
 * previews rather than silently eaten.
 */
export function t(
    key: TranslationKeys,
    locale: Locale = defaultLocale,
    values?: InterpolationValues,
): string {
    const primary = resolvePath(bundles[locale], key);
    if (primary !== undefined) return interpolate(primary, values);

    const fallback =
        locale === fallbackLocale ? undefined : resolvePath(bundles[fallbackLocale], key);
    if (fallback !== undefined) {
        if (!isProduction()) {
            console.warn(`[i18n] Missing "${key}" for locale "${locale}" — using "${fallbackLocale}".`);
        }
        return interpolate(fallback, values);
    }

    if (!isProduction()) {
        console.warn(`[i18n] Missing "${key}" in every bundle — returning key as-is.`);
    }
    return key;
}

/**
 * Create a translator bound to a specific locale — convenient for request-
 * scoped use (SSR, mobile screens) where the locale is resolved once and
 * then reused for every lookup.
 *
 * The returned function accepts the same optional `values` bag as {@link t}
 * so placeholder interpolation works the same way via either entry point.
 */
export function createTranslator(
    locale: Locale,
): (key: TranslationKeys, values?: InterpolationValues) => string {
    return (key, values) => t(key, locale, values);
}
