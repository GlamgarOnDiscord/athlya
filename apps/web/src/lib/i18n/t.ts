/**
 * Curried translator factory for the Athlya web app.
 *
 * The Hono API and the domain services speak the shared bundle
 * directly (`t(key, locale, values?)`); client and server components
 * benefit from a locale-bound flavour — the locale is resolved once
 * per request (server components) or once per app lifetime (client
 * components, mounted under a `LocaleProvider`).
 *
 * Rationale
 * ---------
 *  - Keeps import sites free of locale-threading boilerplate: a
 *    component that needs a string calls `t('web.home.title')` and
 *    the provider decides which bundle to read.
 *  - Delegates every edge case — missing-key warning, English
 *    fallback, placeholder interpolation, Unicode handling — to the
 *    canonical `@athlya/shared/i18n` helper, so the web app never
 *    re-implements those semantics.
 *
 * @see Requirement 28.1 — every user-facing string resolves through
 *      the shared bundle, not component-level literals.
 * @see Task 10.6 deliverable #2 — "Curried translator".
 */
import { t as translate } from '@athlya/shared/i18n';

import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

/**
 * Signature of the translator function returned by
 * {@link createTranslator}.
 *
 * Typed against {@link TranslationKeys} so IDEs catch key typos at
 * build time. The shared helper tolerates string-at-runtime usage
 * (returns the key verbatim on miss), so this stricter surface is
 * purely an ergonomics choice.
 */
export type Translator = (
  key: TranslationKeys,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * Create a translator bound to the request's resolved locale.
 *
 * The returned function is referentially stable for a given `locale`
 * argument — call sites that memoise on the translator (e.g. React
 * `useMemo`) should also pass the locale to their dep array.
 *
 * @example
 * const t = createTranslator('fr');
 * t('web.home.title');                          // → "Athlya"
 * t('reservations.waitlistPosition', { position: 3 });
 *                                               // → "Position sur la liste d'attente : 3"
 */
export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(key, locale, params);
}
