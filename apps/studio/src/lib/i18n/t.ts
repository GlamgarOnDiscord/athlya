/**
 * Curried translator factory — studio admin copy. Same shape as
 * `apps/web/src/lib/i18n/t.ts`. The dotted-path keys are typed against
 * the English bundle of `@athlya/shared/i18n`, so studio-only strings
 * are added under the `studio.*` namespace and shared keys
 * (`common.*`, `auth.*`) work out of the box.
 *
 * @see Requirement 28.1.
 */
import { t as translate } from '@athlya/shared/i18n';

import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export type Translator = (
    key: TranslationKeys,
    params?: Readonly<Record<string, string | number>>,
) => string;

export function createTranslator(locale: Locale): Translator {
    return (key, params) => translate(key, locale, params);
}
