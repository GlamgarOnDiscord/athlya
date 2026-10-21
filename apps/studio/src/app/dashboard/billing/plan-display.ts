import type { Translator } from '../../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

export type PlanKey = 'free' | 'pro';

export const PLAN_KEYS: ReadonlyArray<PlanKey> = ['free', 'pro'];

/** Monthly list price shown on each plan card, in euros. Display only. */
const MONTHLY_PRICE_EUR: Readonly<Record<PlanKey, number>> = { free: 0, pro: 49 };

/** "49 €" in French, "€49" in English: the locale decides symbol side and spacing. */
export function formatEuros(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** "49 € / mois", "€49 / month". */
export function formatPlanPrice(plan: PlanKey, locale: Locale, t: Translator): string {
  return t('studio.billing.pricePerMonth', {
    price: formatEuros(MONTHLY_PRICE_EUR[plan], locale),
  });
}

/** "Gratuit" / "Free", "Pro". */
export function planName(plan: PlanKey, t: Translator): string {
  return t(`studio.billing.plans.${plan}.title`);
}
