/**
 * Pure mapping from a verified Stripe event to the billing state change
 * and Athlya bus event it implies (issue #122). The wiring layer applies
 * the effect in ONE database statement together with the Stripe event
 * claim (`billing_apply_stripe_event`, migration 0036).
 *
 * Handled events:
 *   checkout.session.completed            → subscription row (+ admin link)
 *   customer.subscription.created         → subscription row + billing.subscription.started
 *   customer.subscription.updated|deleted → subscription row
 *   invoice.paid|finalized|voided|marked_uncollectible|updated → invoice row
 *   invoice.payment_failed                → invoice row + billing.subscription.failed
 *
 * The bus envelope never carries `payload.userId` from here: the
 * database fills it from the session metadata or the stored
 * subscription (`initiated_by`), and drops the event when there is no
 * recipient.
 */

import type { StripeEvent } from './webhook.js';

export interface SubscriptionChange {
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string | null;
  readonly status: string;
  readonly priceId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export interface InvoiceChange {
  readonly stripeInvoiceId: string;
  readonly stripeSubscriptionId: string | null;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly amountDue: number;
  readonly currency: string;
  readonly hostedInvoiceUrl: string | null;
  readonly createdAt: string;
}

export interface BillingBusEvent {
  readonly id: string;
  readonly type: 'billing.subscription.started' | 'billing.subscription.failed';
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface StripeEventEffect {
  readonly studioId: string | null;
  readonly userId: string | null;
  readonly subscription: SubscriptionChange | null;
  readonly invoice: InvoiceChange | null;
  readonly event: BillingBusEvent | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INVOICE_STATUSES = new Set<InvoiceStatus>(['draft', 'open', 'paid', 'uncollectible', 'void']);
const PLAN = 'pro';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function str(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function uuid(value: unknown): string | null {
  const s = str(value, 36);
  return s !== null && UUID.test(s) ? s.toLowerCase() : null;
}

/** Stripe ids are either a string or an expanded object with `id`. */
function stripeId(value: unknown): string | null {
  return str(value) ?? str(obj(value)?.['id']);
}

function unixToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}

function dataObject(event: StripeEvent): Obj | null {
  return obj(obj(event.data)?.['object']);
}

function metadataIds(source: Obj | null): { studioId: string | null; userId: string | null } {
  const metadata = obj(source?.['metadata']);
  return { studioId: uuid(metadata?.['studioId']), userId: uuid(metadata?.['userId']) };
}

function subscriptionChange(sub: Obj, forcedStatus?: string): SubscriptionChange | null {
  const id = stripeId(sub['id']);
  const status = forcedStatus ?? str(sub['status'], 40);
  if (id === null || status === null) return null;
  const item = obj((obj(sub['items'])?.['data'] as unknown[] | undefined)?.[0]);
  return {
    stripeSubscriptionId: id,
    stripeCustomerId: stripeId(sub['customer']),
    status,
    priceId: stripeId(item?.['price']),
    // API ≥ 2025-03 moved the period onto the subscription item.
    currentPeriodEnd:
      unixToIso(sub['current_period_end']) ?? unixToIso(item?.['current_period_end']),
    cancelAtPeriodEnd: sub['cancel_at_period_end'] === true,
  };
}

function invoiceSubscriptionId(inv: Obj): string | null {
  // API ≥ 2025-03: invoice.parent.subscription_details.subscription.
  const details = obj(obj(inv['parent'])?.['subscription_details']);
  return stripeId(inv['subscription']) ?? stripeId(details?.['subscription']);
}

function invoiceChange(inv: Obj): InvoiceChange | null {
  const id = stripeId(inv['id']);
  const status = str(inv['status'], 20) as InvoiceStatus | null;
  const amountDue = inv['amount_due'];
  const currency = str(inv['currency'], 3);
  const createdAt = unixToIso(inv['created']);
  if (
    id === null ||
    status === null ||
    !INVOICE_STATUSES.has(status) ||
    typeof amountDue !== 'number' ||
    !Number.isInteger(amountDue) ||
    amountDue < 0 ||
    currency === null ||
    currency.length !== 3 ||
    createdAt === null
  ) {
    return null;
  }
  const hosted = str(inv['hosted_invoice_url'], 2048);
  return {
    stripeInvoiceId: id,
    stripeSubscriptionId: invoiceSubscriptionId(inv),
    number: str(inv['number'], 80),
    status,
    amountDue,
    currency: currency.toLowerCase(),
    hostedInvoiceUrl: hosted !== null && hosted.startsWith('https://') ? hosted : null,
    createdAt,
  };
}

/**
 * Map a verified Stripe event. Returns `null` for event types Athlya
 * does not track and for tracked events whose object is malformed (the
 * caller acknowledges both so Stripe stops retrying).
 */
export function mapStripeEvent(
  event: StripeEvent,
  newEventId: () => string,
  now: () => Date = () => new Date(),
): StripeEventEffect | null {
  const object = dataObject(event);
  if (object === null) return null;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (object['mode'] !== 'subscription') return null;
      const subscriptionId = stripeId(object['subscription']);
      if (subscriptionId === null) return null;
      const ids = metadataIds(object);
      return {
        ...ids,
        studioId: ids.studioId ?? uuid(object['client_reference_id']),
        subscription: {
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: stripeId(object['customer']),
          status: object['payment_status'] === 'paid' ? 'active' : 'incomplete',
          priceId: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
        invoice: null,
        event: null,
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const change = subscriptionChange(
        object,
        event.type === 'customer.subscription.deleted' ? 'canceled' : undefined,
      );
      if (change === null) return null;
      const startsAt = unixToIso(object['start_date']) ?? now().toISOString();
      return {
        ...metadataIds(object),
        subscription: change,
        invoice: null,
        event:
          event.type === 'customer.subscription.created'
            ? {
                id: newEventId(),
                type: 'billing.subscription.started',
                occurredAt: now().toISOString(),
                payload: { subscriptionId: change.stripeSubscriptionId, plan: PLAN, startsAt },
              }
            : null,
      };
    }

    case 'invoice.paid':
    case 'invoice.finalized':
    case 'invoice.updated':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
    case 'invoice.payment_failed': {
      const change = invoiceChange(object);
      if (change === null) return null;
      const failed = event.type === 'invoice.payment_failed';
      const reason =
        str(obj(object['last_finalization_error'])?.['message'], 500) ?? 'invoice_payment_failed';
      return {
        studioId: null,
        userId: null,
        subscription: null,
        invoice: change,
        event:
          failed && change.stripeSubscriptionId !== null
            ? {
                id: newEventId(),
                type: 'billing.subscription.failed',
                occurredAt: now().toISOString(),
                payload: { subscriptionId: change.stripeSubscriptionId, reason },
              }
            : null,
      };
    }

    default:
      return null;
  }
}
