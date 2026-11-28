import { MEMBER_NOTIFICATION_CATALOG } from '@athlya/shared/schemas/api';

import type { TranslationKeys } from '@athlya/shared/i18n';
import type { MemberNotification, NotificationChannel } from '@athlya/shared/schemas/api';

export interface MemberNotificationRow {
  /** Key of the message in `MEMBER_NOTIFICATION_CATALOG` and `notifications.*`. */
  readonly event: MemberNotification;
  readonly labelKey: TranslationKeys;
  readonly channels: ReadonlyArray<NotificationChannel>;
  /** Safety or payment message: always sent, shown locked. */
  readonly mandatory: boolean;
}

const LABEL_KEYS: Readonly<Record<MemberNotification, TranslationKeys>> = {
  reservationCreated: 'web.settings.notifications.events.reservationCreated',
  reservationReminder: 'web.settings.notifications.events.reservationReminder',
  reservationCancelled: 'web.settings.notifications.events.reservationCancelled',
  reservationPromoted: 'web.settings.notifications.events.reservationPromoted',
  billingSubscriptionFailed: 'web.settings.notifications.events.billingSubscriptionFailed',
  passwordReset: 'web.settings.notifications.events.passwordReset',
};

/**
 * Messages the notifications service sends a member, in display order,
 * from the shared catalog the API and the consumer read too
 * (issue #762).
 */
export const MEMBER_NOTIFICATIONS: ReadonlyArray<MemberNotificationRow> = (
  Object.keys(MEMBER_NOTIFICATION_CATALOG) as MemberNotification[]
).map((event) => ({
  event,
  labelKey: LABEL_KEYS[event],
  channels: MEMBER_NOTIFICATION_CATALOG[event].channels,
  mandatory: MEMBER_NOTIFICATION_CATALOG[event].mandatory,
}));

export const CHANNEL_KEYS: Readonly<Record<NotificationChannel, TranslationKeys>> = {
  email: 'web.settings.notifications.channels.email',
  push: 'web.settings.notifications.channels.push',
};

/** Translation keys of a message's channels, in display order. */
export function channelKeys(notification: MemberNotificationRow): ReadonlyArray<TranslationKeys> {
  return notification.channels.map((channel) => CHANNEL_KEYS[channel]);
}
