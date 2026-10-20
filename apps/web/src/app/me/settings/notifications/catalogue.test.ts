import { bundles } from '@athlya/shared/i18n';
import { describe, expect, it } from 'vitest';

import { createTranslator } from '../../../../lib/i18n/t';

import { channelKeys, MEMBER_NOTIFICATIONS } from './catalogue';

describe('MEMBER_NOTIFICATIONS', () => {
  it('lists only messages the notifications consumer has templates for', () => {
    for (const { event, channels } of MEMBER_NOTIFICATIONS) {
      for (const locale of ['fr', 'en'] as const) {
        const templates: Record<string, unknown> = bundles[locale].notifications[event];
        for (const channel of channels) {
          expect(templates[channel], `${locale} ${event} ${channel}`).toBeDefined();
        }
      }
    }
  });

  it('lists each message once', () => {
    const events = MEMBER_NOTIFICATIONS.map((n) => n.event);
    expect(new Set(events).size).toBe(events.length);
  });

  it('resolves every label and channel in both locales', () => {
    for (const locale of ['fr', 'en'] as const) {
      const t = createTranslator(locale);
      for (const notification of MEMBER_NOTIFICATIONS) {
        expect(t(notification.labelKey)).not.toBe(notification.labelKey);
        for (const key of channelKeys(notification)) {
          expect(t(key)).not.toBe(key);
        }
      }
    }
  });

  it('keeps the channel order of the definition', () => {
    const created = MEMBER_NOTIFICATIONS.find((n) => n.event === 'reservationCreated');
    expect(created && channelKeys(created)).toEqual([
      'web.settings.notifications.channels.email',
      'web.settings.notifications.channels.push',
    ]);
  });
});
