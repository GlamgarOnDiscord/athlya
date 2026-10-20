import { describe, expect, it } from 'vitest';

import { createTranslator } from '../../../lib/i18n/t';

import {
  actionLabel,
  auditCategory,
  formatEventTime,
  shortId,
  targetTypeLabel,
} from './audit-format';

const fr = createTranslator('fr');
const en = createTranslator('en');

describe('actionLabel', () => {
  it('labels a known slug in both locales', () => {
    expect(actionLabel('reservation.cancelled_by_admin', fr)).toBe(
      'Réservation annulée par un admin',
    );
    expect(actionLabel('reservation.cancelled_by_admin', en)).toBe('Booking cancelled by an admin');
  });

  it('returns null for an unknown slug so the caller shows the raw code', () => {
    expect(actionLabel('class.created', fr)).toBeNull();
    expect(actionLabel('toString', fr)).toBeNull();
  });
});

/**
 * Every action slug the API writes to `audit_log`: `AUDIT_ACTIONS` in
 * `packages/api/src/audit.ts`, plus the one literal slug written outside
 * it, `token.refresh.reuse.detected` (`packages/auth/src/service.ts`).
 */
const API_ACTIONS = [
  'user.registered',
  'user.deleted',
  'reservation.cancelled_by_admin',
  'rls.violation',
  'billing.webhook.signature_failed',
  'billing.webhook.processed',
  'user.consents.updated',
  'jwt.key.rotation_prep',
  'dlq.entry.replayed',
  'dlq.entry.discarded',
  'token.refresh.reuse.detected',
] as const;

describe('actionLabel coverage', () => {
  it.each(API_ACTIONS)('labels %s in French and in English', (action) => {
    const frLabel = actionLabel(action, fr);
    const enLabel = actionLabel(action, en);
    expect(frLabel).not.toBeNull();
    expect(enLabel).not.toBeNull();
    expect(frLabel).not.toBe(action);
    expect(frLabel, 'French falls back to English').not.toBe(enLabel);
  });
});

describe('targetTypeLabel', () => {
  it('labels a known type and keeps an unknown one raw', () => {
    expect(targetTypeLabel('reservation', fr)).toBe('Réservation');
    expect(targetTypeLabel('invoice', fr)).toBe('invoice');
  });

  it('labels every target type the API writes', () => {
    expect(targetTypeLabel('dlq_entry', fr)).toBe('Tâche en échec');
    expect(targetTypeLabel('jwt_key', fr)).toBe('Clé de signature');
    expect(targetTypeLabel('stripe_webhook', fr)).toBe('Événement de paiement');
    expect(targetTypeLabel('user', fr)).toBe('Membre');
  });
});

describe('shortId', () => {
  it('keeps the first eight characters of a long id', () => {
    expect(shortId('0e000000-0000-4000-8000-000000000007')).toBe('0e000000…');
    expect(shortId('admin-1')).toBe('admin-1');
  });
});

describe('formatEventTime', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');

  it('is relative within the last hour, in minutes', () => {
    expect(formatEventTime('2026-10-20T11:55:00.000Z', now, 'en')).toMatch(/^5\smin\. ago$/u);
  });

  it('is relative within the last day, in hours', () => {
    expect(formatEventTime('2026-10-20T09:00:00.000Z', now, 'fr')).toMatch(/^il\sy\sa\s3\sh$/u);
  });

  it('is absolute past one day and for a future time', () => {
    const old = formatEventTime('2026-10-18T09:00:00.000Z', now, 'en');
    expect(old).toContain('Oct');
    expect(old).toContain('2026');
    expect(formatEventTime('2026-10-20T13:00:00.000Z', now, 'en')).toContain('2026');
  });
});

describe('auditCategory', () => {
  it('groups slugs by their first segment', () => {
    expect(auditCategory('reservation.cancelled_by_admin')).toBe('reservations');
    expect(auditCategory('billing.webhook.processed')).toBe('billing');
    expect(auditCategory('user.consents.updated')).toBe('accounts');
    expect(auditCategory('token.refresh.reuse.detected')).toBe('accounts');
    expect(auditCategory('dlq.entry.replayed')).toBe('system');
  });
});
