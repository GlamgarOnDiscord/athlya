import type { Locale } from '@athlya/shared/i18n';

const BCP47: Readonly<Record<Locale, string>> = { fr: 'fr-FR', en: 'en-GB' };

/** "Tue 21 Oct, 18:30" in the device time zone. */
export function formatDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(BCP47[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "21 Oct 2026" for a `YYYY-MM-DD` calendar date, read as that local day. */
export function formatLocalDate(date: string, locale: Locale): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(BCP47[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

/** "18 Oct 2026" for a `YYYY-MM-DD` UTC day (the progression API's calendar). */
export function formatUtcDay(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(BCP47[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** A count or a weight with at most one decimal, e.g. "1,250.5" / "1 250,5". */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale], { maximumFractionDigits: 1 }).format(value);
}
