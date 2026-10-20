import type { TranslationKeys } from '@athlya/shared/i18n';

export type NotificationChannel = 'email' | 'push';

export interface MemberNotification {
  /** Key of the message under the shared `notifications.*` namespace. */
  readonly event:
    'reservationCreated' | 'reservationReminder' | 'reservationCancelled' | 'reservationPromoted';
  readonly labelKey: TranslationKeys;
  readonly channels: ReadonlyArray<NotificationChannel>;
}

/**
 * Booking messages the notifications consumer sends a member
 * (`packages/notifications/src/consumer.ts`), with their channels. All of
 * them are transactional, so they are always sent: there is no per-event
 * preference in the API yet, and this list is read-only.
 */
export const MEMBER_NOTIFICATIONS: ReadonlyArray<MemberNotification> = [
  {
    event: 'reservationCreated',
    labelKey: 'web.settings.notifications.events.reservationCreated',
    channels: ['email', 'push'],
  },
  {
    event: 'reservationReminder',
    labelKey: 'web.settings.notifications.events.reservationReminder',
    channels: ['push'],
  },
  {
    event: 'reservationCancelled',
    labelKey: 'web.settings.notifications.events.reservationCancelled',
    channels: ['email', 'push'],
  },
  {
    event: 'reservationPromoted',
    labelKey: 'web.settings.notifications.events.reservationPromoted',
    channels: ['email', 'push'],
  },
];

const CHANNEL_KEYS: Readonly<Record<NotificationChannel, TranslationKeys>> = {
  email: 'web.settings.notifications.channels.email',
  push: 'web.settings.notifications.channels.push',
};

/** Translation keys of a message's channels, in display order. */
export function channelKeys(notification: MemberNotification): ReadonlyArray<TranslationKeys> {
  return notification.channels.map((channel) => CHANNEL_KEYS[channel]);
}
