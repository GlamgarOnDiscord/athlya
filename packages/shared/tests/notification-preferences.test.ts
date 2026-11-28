import { describe, expect, it } from 'vitest';

import {
  isNotificationEnabled,
  MEMBER_NOTIFICATION_CATALOG,
  NotificationPreferencesSchema,
  resolveNotificationPreferences,
  storeNotificationPreferences,
} from '../src/schemas/api.js';

const ALL_ON = {
  reservationCreated: { email: true, push: true },
  reservationReminder: { push: true },
  reservationCancelled: { email: true, push: true },
  reservationPromoted: { email: true, push: true },
};

describe('member notification catalog', () => {
  it('keeps the payment failure and the password reset mandatory', () => {
    expect(MEMBER_NOTIFICATION_CATALOG.billingSubscriptionFailed.mandatory).toBe(true);
    expect(MEMBER_NOTIFICATION_CATALOG.passwordReset.mandatory).toBe(true);
  });
});

describe('NotificationPreferencesSchema', () => {
  it('accepts the full set of toggles', () => {
    expect(NotificationPreferencesSchema.safeParse(ALL_ON).success).toBe(true);
  });

  it('refuses to turn a mandatory message off', () => {
    expect(
      NotificationPreferencesSchema.safeParse({ ...ALL_ON, passwordReset: { email: false } })
        .success,
    ).toBe(false);
    expect(
      NotificationPreferencesSchema.safeParse({
        ...ALL_ON,
        billingSubscriptionFailed: { email: false },
      }).success,
    ).toBe(false);
  });

  it('refuses a channel the message does not use', () => {
    expect(
      NotificationPreferencesSchema.safeParse({
        ...ALL_ON,
        reservationReminder: { push: true, email: false },
      }).success,
    ).toBe(false);
  });
});

describe('stored preferences', () => {
  it('store only what is off and read back the same toggles', () => {
    const prefs = {
      ...ALL_ON,
      reservationCreated: { email: false, push: true },
      reservationReminder: { push: false },
    };
    const stored = storeNotificationPreferences(prefs);
    expect(stored).toEqual({
      reservationCreated: { email: false },
      reservationReminder: { push: false },
    });
    expect(resolveNotificationPreferences(stored)).toEqual(prefs);
  });

  it('read an empty or malformed column as everything on', () => {
    expect(resolveNotificationPreferences(null)).toEqual(ALL_ON);
    expect(resolveNotificationPreferences('nonsense')).toEqual(ALL_ON);
    expect(resolveNotificationPreferences({ reservationCreated: 'off' })).toEqual(ALL_ON);
  });

  it('never stop a mandatory or unknown message', () => {
    const stored = { passwordReset: { email: false }, somethingNew: { email: false } };
    expect(isNotificationEnabled(stored, 'passwordReset', 'email')).toBe(true);
    expect(isNotificationEnabled(stored, 'somethingNew', 'email')).toBe(true);
    expect(
      isNotificationEnabled(
        { reservationCreated: { email: false } },
        'reservationCreated',
        'email',
      ),
    ).toBe(false);
    expect(
      isNotificationEnabled({ reservationCreated: { email: false } }, 'reservationCreated', 'push'),
    ).toBe(true);
  });
});
