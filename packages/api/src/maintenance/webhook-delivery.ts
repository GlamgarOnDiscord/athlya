/**
 * Webhook delivery from the cron (issue #760).
 *
 * Each tick claims up to {@link WEBHOOK_BATCH_LIMIT} due deliveries
 * (`webhook_claim_deliveries`, a 2-minute lease and the attempt counted),
 * posts them in parallel and records each outcome
 * (`webhook_record_attempt`: 2xx delivered, otherwise a retry with
 * backoff, failed after the sixth attempt). Runs as `athlya_cron`.
 *
 * Request sent to an endpoint:
 *   POST <url>
 *   content-type: application/json
 *   athlya-event: <event type>
 *   athlya-delivery: <delivery id>  (stable across retries)
 *   athlya-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *   {"id": <event id>, "type": ..., "occurredAt": ..., "data": <event payload>}
 *
 * The receiver recomputes the HMAC over the raw body with its secret,
 * compares in constant time and rejects a timestamp older than 5 minutes.
 * Redirects are not followed and count as a failure. The URL is checked
 * again before each send. Logs carry ids and status codes only, never a
 * URL, a secret or a payload.
 */

import { WebhookUrlSchema } from '@athlya/shared/schemas/api';

export const WEBHOOK_BATCH_LIMIT = 20;
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookDeliveryExecutor {
  selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
}

export interface WebhookDeliveryDeps {
  readonly executeSql: WebhookDeliveryExecutor;
  readonly fetch: typeof fetch;
  /** Unix seconds; defaults to the wall clock. */
  readonly now?: () => number;
}

export interface WebhookDeliveryResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
}

interface ClaimedDelivery {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly occurred_at: Date | string;
  readonly attempts: number;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `t=<timestamp>,v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`. */
export async function webhookSignature(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=${hex(mac)}`;
}

/** The JSON body of a delivery. */
export function webhookBody(delivery: ClaimedDelivery): string {
  const occurredAt =
    delivery.occurred_at instanceof Date
      ? delivery.occurred_at.toISOString()
      : new Date(delivery.occurred_at).toISOString();
  return JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    occurredAt,
    data: (typeof delivery.payload === 'string'
      ? JSON.parse(delivery.payload)
      : delivery.payload) as unknown,
  });
}

async function send(
  delivery: ClaimedDelivery,
  deps: WebhookDeliveryDeps,
): Promise<{ status: number | null; error: string | null }> {
  if (!WebhookUrlSchema.safeParse(delivery.url).success) {
    return { status: null, error: 'url_refused' };
  }
  const body = webhookBody(delivery);
  const timestamp = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  try {
    const res = await deps.fetch(delivery.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Athlya-Webhooks/1',
        'athlya-event': delivery.event_type,
        'athlya-delivery': delivery.id,
        'athlya-signature': await webhookSignature(delivery.secret, timestamp, body),
      },
      body,
    });
    // The body is never read: only the status matters.
    await res.body?.cancel();
    return { status: res.status, error: res.ok ? null : `http_${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { status: null, error: name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

export async function runWebhookDeliveries(
  deps: WebhookDeliveryDeps,
): Promise<WebhookDeliveryResult> {
  const claimed = await deps.executeSql.selectRows<ClaimedDelivery>(
    'SELECT * FROM webhook_claim_deliveries($1::integer)',
    [WEBHOOK_BATCH_LIMIT],
  );
  const outcomes = await Promise.all(
    claimed.map(async (delivery) => {
      const { status, error } = await send(delivery, deps);
      const [row] = await deps.executeSql.selectRows<{ status: string | null }>(
        'SELECT webhook_record_attempt($1::uuid, $2::integer, $3::text) AS status',
        [delivery.id, status, error],
      );
      return row?.status ?? null;
    }),
  );
  const result = {
    attempted: claimed.length,
    delivered: outcomes.filter((s) => s === 'delivered').length,
    retrying: outcomes.filter((s) => s === 'pending').length,
    failed: outcomes.filter((s) => s === 'failed').length,
  };
  if (result.attempted > 0) console.info('webhooks: delivery tick', result);
  return result;
}
