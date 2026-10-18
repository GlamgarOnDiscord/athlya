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
