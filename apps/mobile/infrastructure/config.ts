import type { Locale } from '@athlya/shared/i18n';

export const DEFAULT_API_URL = 'https://api.athlya.app';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

/**
 * Resolves the API origin from `EXPO_PUBLIC_API_URL`. Only HTTPS is
 * accepted, except for loopback hosts used against a local `wrangler dev`
 * (`10.0.2.2` is the Android emulator's alias for the host machine).
 */
export function resolveApiBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_URL;
  const url = new URL(raw.trim());
  const insecureAllowed = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !insecureAllowed) {
    throw new Error(`EXPO_PUBLIC_API_URL must use https (got ${url.protocol})`);
  }
  return url.origin;
}

/** Maps a BCP 47 tag to a supported bundle: English for `en-*`, French otherwise. */
export function resolveLocale(tag: string | undefined): Locale {
  return tag?.toLowerCase().startsWith('en') === true ? 'en' : 'fr';
}
