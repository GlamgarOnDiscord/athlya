/**
 * Display helpers for the audit log: human labels for the stable action
 * slugs (`packages/api/src/audit.ts`), target type labels, short ids
 * and event times. Unknown slugs and types fall back to the raw code so
 * a new action never renders blank.
 */
import type { Translator } from '../../../lib/i18n/t';
import type { Locale, TranslationKeys } from '@athlya/shared/i18n';

export interface AuditItem {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

const ACTION_LABELS: Readonly<Record<string, TranslationKeys>> = {
  'user.registered': 'studio.audit.actions.userRegistered',
  'user.deleted': 'studio.audit.actions.userDeleted',
  'user.consents.updated': 'studio.audit.actions.userConsentsUpdated',
  'reservation.cancelled_by_admin': 'studio.audit.actions.reservationCancelledByAdmin',
  'rls.violation': 'studio.audit.actions.rlsViolation',
  'billing.webhook.processed': 'studio.audit.actions.billingWebhookProcessed',
  'billing.webhook.signature_failed': 'studio.audit.actions.billingWebhookSignatureFailed',
  'jwt.key.rotation_prep': 'studio.audit.actions.jwtKeyRotationPrep',
  'dlq.entry.replayed': 'studio.audit.actions.dlqEntryReplayed',
  'dlq.entry.discarded': 'studio.audit.actions.dlqEntryDiscarded',
  'token.refresh.reuse.detected': 'studio.audit.actions.tokenRefreshReuseDetected',
};

const TARGET_LABELS: Readonly<Record<string, TranslationKeys>> = {
  user: 'studio.audit.targets.user',
  reservation: 'studio.audit.targets.reservation',
  class: 'studio.audit.targets.class',
  studio: 'studio.audit.targets.studio',
  stripe_webhook: 'studio.audit.targets.stripe_webhook',
};

/** Human label for an action slug, or `null` when the slug has none yet. */
export function actionLabel(action: string, t: Translator): string | null {
  const key = Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action] : undefined;
  return key === undefined ? null : t(key);
}

/** Human label for a target type, falling back to the raw type. */
export function targetTypeLabel(targetType: string, t: Translator): string {
  const key = Object.hasOwn(TARGET_LABELS, targetType) ? TARGET_LABELS[targetType] : undefined;
  return key === undefined ? targetType : t(key);
}

const SHORT_ID_LENGTH = 8;

export function shortId(id: string): string {
  return id.length > SHORT_ID_LENGTH ? `${id.slice(0, SHORT_ID_LENGTH)}…` : id;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Relative time for events of the last 24 hours ("5 min ago",
 * "il y a 3 h"), the absolute date and time otherwise or when the event
 * sits in the future (clock skew).
 */
export function formatEventTime(iso: string, now: Date, locale: Locale): string {
  const at = new Date(iso);
  const elapsed = now.getTime() - at.getTime();
  if (elapsed >= 0 && elapsed < DAY_MS) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    if (elapsed < HOUR_MS) return rtf.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
    return rtf.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  }
  return formatEventDate(iso, locale);
}

/** Absolute date and time, used as the tooltip of a relative time. */
export function formatEventDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
