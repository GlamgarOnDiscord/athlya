/**
 * Stateless, revocable tokens for the members' iCalendar feeds (issue
 * #719, `docs/architecture/calendar-feed.md`).
 *
 * A calendar client cannot send a JWT, so the subscription URL itself
 * carries the credential (`?token=`): `<payload>.<mac>`, both base64url, where the
 * payload is `v1.<memberId>.<studioId>.<credentialsVersion>` and the MAC
 * is HMAC-SHA256 keyed by `CALENDAR_FEED_SIGNING_KEY` over a
 * domain-separated copy of the payload. Nothing is stored server side:
 *
 *   - rotating the key revokes every feed at once;
 *   - `credentialsVersion` is the member's `users.credentials_version`,
 *     bumped on logout-all, password reset, role or studio change, so
 *     any of those revokes that member's feed (checked by the adapter).
 *
 * The MAC is verified with `crypto.subtle.verify` (constant time) before
 * the payload is parsed.
 */

import { fromBase64Url, toBase64Url } from './export-download.js';

/** Minimum key length; a shorter key is treated as not configured. */
export const CALENDAR_FEED_MIN_KEY_LENGTH = 32;

/** Stable failure reason when the key or the public base URL is unset. */
export const CALENDAR_FEED_NOT_CONFIGURED = 'calendar_feed_not_configured';

const TOKEN_FORMAT = 'v1';
const MAC_CONTEXT = 'athlya-calendar-feed';
/** Two UUIDs, a version and separators stay far below this. */
const MAX_TOKEN_LENGTH = 256;
const MAC_BYTES = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Identity a feed token is bound to. */
export interface CalendarFeedSubject {
  readonly memberId: string;
  readonly studioId: string;
  readonly credentialsVersion: number;
}

/** True when `secret` is long enough to sign feed tokens. */
export function isCalendarFeedKeyConfigured(secret: string | undefined): secret is string {
  return secret !== undefined && secret.length >= CALENDAR_FEED_MIN_KEY_LENGTH;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function macInput(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${MAC_CONTEXT}:`);
  const input = new Uint8Array(prefix.length + payload.length);
  input.set(prefix, 0);
  input.set(payload, prefix.length);
  return input;
}

/** Sign a feed token for `subject`. */
export async function signCalendarFeedToken(
  secret: string,
  subject: CalendarFeedSubject,
): Promise<string> {
  const payload = encoder.encode(
    [
      TOKEN_FORMAT,
      subject.memberId.toLowerCase(),
      subject.studioId.toLowerCase(),
      String(subject.credentialsVersion),
    ].join('.'),
  );
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), macInput(payload));
  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(mac))}`;
}

function parsePayload(payload: Uint8Array): CalendarFeedSubject | null {
  let text: string;
  try {
    text = decoder.decode(payload);
  } catch {
    return null;
  }
  const [format, memberId, studioId, version, ...rest] = text.split('.');
  if (
    rest.length > 0 ||
    format !== TOKEN_FORMAT ||
    memberId === undefined ||
    studioId === undefined ||
    version === undefined ||
    !UUID_RE.test(memberId) ||
    !UUID_RE.test(studioId) ||
    !/^[1-9][0-9]{0,9}$/u.test(version)
  ) {
    return null;
  }
  return { memberId, studioId, credentialsVersion: Number(version) };
}

/**
 * Verify `token` and return its subject, or `null` for any malformed,
 * tampered or foreign token. Callers must not tell these cases apart.
 */
export async function verifyCalendarFeedToken(
  secret: string,
  token: string,
): Promise<CalendarFeedSubject | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [rawPayload, rawMac] = parts as [string, string];
  const payload = fromBase64Url(rawPayload);
  const mac = fromBase64Url(rawMac);
  if (payload === null || payload.length === 0 || mac === null || mac.length !== MAC_BYTES) {
    return null;
  }
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, macInput(payload));
  return valid ? parsePayload(payload) : null;
}

/** Subscription URLs (`https://` and `webcal://`) for a signed token. */
export function buildCalendarFeedUrls(
  baseUrl: string,
  token: string,
): { readonly httpsUrl: string; readonly webcalUrl: string } {
  const url = new URL('/v1/calendar/feed.ics', baseUrl);
  url.searchParams.set('token', token);
  const httpsUrl = url.toString();
  return { httpsUrl, webcalUrl: httpsUrl.replace(/^https?:/u, 'webcal:') };
}
