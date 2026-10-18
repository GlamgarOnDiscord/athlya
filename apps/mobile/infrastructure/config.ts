import type { Locale } from '@athlya/shared/i18n';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '10.0.2.2']);

/**
 * Resolves the API origin from `EXPO_PUBLIC_API_URL`, which every build
 * must set explicitly (EAS profiles do it in `eas.json`): a missing value
 * fails the boot instead of silently pointing a build at production. Only
 * HTTPS is accepted, except for loopback hosts used against a local
 * `wrangler dev` (`10.0.2.2` is the Android emulator's alias for the host).
 */
export function resolveApiBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('EXPO_PUBLIC_API_URL is not set');
  }
  const url = new URL(raw.trim());
  const insecureAllowed = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !insecureAllowed) {
    throw new Error(`EXPO_PUBLIC_API_URL must use https (got ${url.protocol})`);
  }
  return url.origin;
}

/** Maps a BCP 47 tag to a supported bundle: English for `en` / `en-*`, French otherwise. */
export function resolveLocale(tag: string | undefined): Locale {
  return tag !== undefined && /^en(?:-|$)/iu.test(tag) ? 'en' : 'fr';
}
