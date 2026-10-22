/**
 * Active sessions of a user: list them and revoke one (issue #757).
 *
 * A session is one refresh-token rotation family. Its family root
 * (`rootSid`) is stable across rotations, so it names the session; the
 * caller never sees it, only {@link sessionHandle}, a truncated SHA-256
 * of it. The access token carries the same handle in its `sh` claim so
 * the list can mark the session the request comes from.
 *
 * What is stored per session (in the Redis payload of each live sid):
 *   - `device`: a coarse browser and operating-system label derived
 *     from the User-Agent at sign-in ({@link describeDevice}). The raw
 *     User-Agent is never kept.
 *   - `createdAt`: when the session signed in, carried across rotations.
 *   - `lastSeenAt`: when the refresh token last rotated, which is when
 *     the device last came back.
 * Sessions written before these fields existed have them `null`.
 */

import { SessionDeviceSchema, type SessionDeviceValue } from '@athlya/shared/schemas/api';

import type { SessionStore } from './service.js';

export type SessionDevice = SessionDeviceValue;
type DeviceBrowser = SessionDevice['browser'];
type DeviceOs = SessionDevice['os'];

/** Metadata recorded when a session is created. */
export interface SessionMeta {
  readonly device?: SessionDevice;
}

/** One live session as the store reads it back. Never leaves the service. */
export interface StoredSession {
  /** A live sid of the family, used to revoke it. */
  readonly sid: string;
  readonly rootSid: string;
  readonly device: SessionDevice | null;
  readonly createdAt: string | null;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string;
}

/** One session as the API returns it. */
export interface SessionSummary {
  readonly id: string;
  readonly device: SessionDevice | null;
  readonly createdAt: string | null;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string;
  readonly current: boolean;
}

/** Coarse browser and OS of a User-Agent. Unknown or absent maps to `other`. */
export function describeDevice(userAgent: string | undefined): SessionDevice {
  const ua = (userAgent ?? '').toLowerCase();
  let os: DeviceOs = 'other';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) os = 'ios';
  else if (ua.includes('android')) os = 'android';
  else if (ua.includes('mac os x') || ua.includes('macintosh')) os = 'macos';
  else if (ua.includes('windows')) os = 'windows';
  else if (ua.includes('linux') || ua.includes('x11')) os = 'linux';

  let browser: DeviceBrowser = 'other';
  if (ua.includes('expo') || ua.includes('okhttp') || ua.includes('cfnetwork')) browser = 'app';
  else if (ua.includes('edg/') || ua.includes('edge/')) browser = 'edge';
  else if (ua.includes('firefox/') || ua.includes('fxios/')) browser = 'firefox';
  else if (ua.includes('chrome/') || ua.includes('crios/')) browser = 'chrome';
  else if (ua.includes('safari/')) browser = 'safari';
  return { browser, os };
}

/** Narrow a stored device back to {@link SessionDevice}; `null` when malformed. */
export function parseDevice(value: unknown): SessionDevice | null {
  const parsed = SessionDeviceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Public handle of a session: the first 32 hex digits of SHA-256(`session:` + rootSid). */
export async function sessionHandle(rootSid: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`session:${rootSid}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

type ListingStore = Pick<SessionStore, 'listForUser' | 'revoke'>;

/**
 * The live sessions of `userId`, most recently seen first. `currentHandle`
 * is the `sh` claim of the caller's access token, when it has one.
 */
export async function listSessions(
  userId: string,
  store: ListingStore,
  currentHandle?: string,
): Promise<SessionSummary[]> {
  const stored = await store.listForUser(userId);
  const summaries = await Promise.all(
    stored.map(async (session) => {
      const id = await sessionHandle(session.rootSid);
      return {
        id,
        device: session.device,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        current: currentHandle !== undefined && id === currentHandle,
      };
    }),
  );
  const seen = (s: SessionSummary): string => s.lastSeenAt ?? s.createdAt ?? '';
  return summaries.sort((a, b) => seen(b).localeCompare(seen(a)));
}

/**
 * Revoke the session of `userId` named `handle`: its whole rotation
 * family stops refreshing. Resolves `false` when no live session of
 * that user carries the handle (unknown, expired, or someone else's).
 */
export async function revokeSession(
  userId: string,
  handle: string,
  store: ListingStore,
): Promise<boolean> {
  const stored = await store.listForUser(userId);
  for (const session of stored) {
    if ((await sessionHandle(session.rootSid)) === handle) {
      await store.revoke(session.sid);
      return true;
    }
  }
  return false;
}
