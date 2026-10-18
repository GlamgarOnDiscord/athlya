/**
 * Canonical set of event types the Worker queue consumers handle.
 * Keep in sync with `route-queue.ts` lanes and `@athlya/notifications`.
 */

import { HANDLED_EVENT_TYPES } from '@athlya/notifications';

/** RGPD lane (`athlya-events-rgpd`). */
export const RGPD_EVENT_TYPES = ['auth.user.deleted', 'members.export.requested'] as const;

/**
 * Auth emails delivered on the notifications lane by the API's own
 * consumer rather than `@athlya/notifications` (issue #645).
 */
export const AUTH_EMAIL_EVENT_TYPES = ['auth.password_reset.requested'] as const;

/** Every type routed to notifications, RGPD, or legacy consumers. */
export const ALL_KNOWN_EVENT_TYPES = [
  ...HANDLED_EVENT_TYPES,
  ...AUTH_EMAIL_EVENT_TYPES,
  ...RGPD_EVENT_TYPES,
] as readonly string[];

export const KNOWN_EVENT_TYPE_SET = new Set<string>(ALL_KNOWN_EVENT_TYPES);

export function isKnownEventType(eventType: string): boolean {
  return KNOWN_EVENT_TYPE_SET.has(eventType);
}
