/**
 * Bundle parity test for the Notifications consumer.
 *
 * The consumer renders every user-facing subject / body / title /
 * body via `t('notifications.*', locale)` from the shared i18n
 * bundle (Requirement 28.3 — all user-facing strings live in
 * `packages/shared/i18n`, no literals in adapter code).
 *
 * This test enumerates every key the consumer currently depends on
 * and asserts that both the French and English bundles contain a
 * non-empty string for it. Adding a new event type without extending
 * both locale bundles therefore fails CI before the broken templates
 * can ship.
 *
 * The enumeration is explicit rather than derived so a contributor
 * who adds a `render*` call for a new key **has** to update this
 * file too — the failure mode "forgot to register the new key" is
 * caught statically by the typed list plus the runtime bundle check.
 *
 * Related requirements: 17.1, 17.2, 28.3.
 */

import { bundles, type TranslationKeys } from '@athlya/shared/i18n';
import { describe, expect, it } from 'vitest';

/**
 * Every notification template key read by
 * `packages/notifications/src/consumer.ts`. Listed flat for
 * readability — the nested JSON layout is still enforced by the
 * compile-time `TranslationKeys` type.
 *
 * Placeholders embedded in the referenced strings:
 *
 *   - `{reservationId}`   — reservationCreated.email.body,
 *                           reservationCancelled.email.body,
 *                           reservationPromoted.email.body
 *   - `{subscriptionId}`  — billingSubscriptionFailed.email.body
 *   - `{reason}`          — billingSubscriptionFailed.email.body
 *
 * Placeholder names are not asserted here — they belong to the
 * consumer's unit tests, which check that rendered output contains
 * the interpolated payload field.
 */
const NOTIFICATION_KEYS: readonly TranslationKeys[] = [
  'notifications.reservationCreated.email.subject',
  'notifications.reservationCreated.email.body',
  'notifications.reservationCreated.push.title',
  'notifications.reservationCreated.push.body',

  'notifications.reservationReminder.push.title',
  'notifications.reservationReminder.push.body',

  'notifications.reservationCancelled.email.subject',
  'notifications.reservationCancelled.email.body',
  'notifications.reservationCancelled.push.title',
  'notifications.reservationCancelled.push.body',

  'notifications.reservationPromoted.email.subject',
  'notifications.reservationPromoted.email.body',
  'notifications.reservationPromoted.push.title',
  'notifications.reservationPromoted.push.body',

  'notifications.billingSubscriptionFailed.email.subject',
  'notifications.billingSubscriptionFailed.email.body',

  'notifications.layout.footer',
  'notifications.layout.footerVia',
  'notifications.layout.footerAthlya',
] as const;

/** Walk a dotted key against a JSON bundle; mirror of the helper. */
function resolvePath(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((cursor, segment) => {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    return (cursor as Record<string, unknown>)[segment];
  }, bundle);
}

describe('notifications i18n keys — bundle parity (Req 28.3)', () => {
  it.each(NOTIFICATION_KEYS)('resolves "%s" to a non-empty string in the French bundle', (key) => {
    const value = resolvePath(bundles.fr, key);
    expect(typeof value, `missing notifications key "${key}" in fr.json`).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
  });

  it.each(NOTIFICATION_KEYS)('resolves "%s" to a non-empty string in the English bundle', (key) => {
    const value = resolvePath(bundles.en, key);
    expect(typeof value, `missing notifications key "${key}" in en.json`).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
  });

  it('keeps the reservationId placeholder in every reservation body template', () => {
    // Guard against a well-meaning contributor stripping the
    // placeholder when translating — the consumer interpolates it,
    // so removing the marker would drop the reference from the
    // final email.
    for (const locale of ['fr', 'en'] as const) {
      for (const key of [
        'notifications.reservationCreated.email.body',
        'notifications.reservationCancelled.email.body',
        'notifications.reservationPromoted.email.body',
      ] as const) {
        const value = resolvePath(bundles[locale], key);
        expect(value).toContain('{reservationId}');
      }
    }
  });

  it('keeps the subscriptionId and reason placeholders in the billing template', () => {
    for (const locale of ['fr', 'en'] as const) {
      const value = resolvePath(
        bundles[locale],
        'notifications.billingSubscriptionFailed.email.body',
      );
      expect(value).toContain('{subscriptionId}');
      expect(value).toContain('{reason}');
    }
  });
});
