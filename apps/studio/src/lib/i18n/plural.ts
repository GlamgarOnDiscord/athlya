/**
 * Plural key selection for the `*One` / `*Other` translation pairs.
 *
 * The bundles carry one string per CLDR category the product needs
 * (`one` and `other`), and `Intl.PluralRules` picks between them, so
 * French reads "0 membre" and "1 membre" while English reads
 * "0 members" and "1 member".
 */
import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export interface PluralKeys {
  readonly one: TranslationKeys;
  readonly other: TranslationKeys;
}

export function pluralKey(locale: Locale, count: number, keys: PluralKeys): TranslationKeys {
  return new Intl.PluralRules(locale).select(count) === 'one' ? keys.one : keys.other;
}
