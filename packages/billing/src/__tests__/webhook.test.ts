/**
 * Unit tests for `@athlya/billing/webhook` — tasks 16.2 and 16.3.
 *
 * Three describe blocks:
 *
 *   1. {@link verifyStripeSignature} — pure crypto primitive. Exercised
 *      end-to-end against a freshly minted HMAC-SHA256 over a synthesised
 *      timestamp and payload. No mocks; the test mints the exact same
 *      signature Stripe would produce and asserts the verifier accepts it.
 *
 *   2. {@link handleStripeWebhook} happy paths. Each of the three Stripe
 *      event types the billing service cares about is dispatched through
 *      injected `vi.fn()` ports; the tests assert the right event envelope
 *      is published and that no audit row is written for valid
 *      signatures.
 *
 *   3. {@link handleStripeWebhook} failure paths. Tampered payloads,
 *      invalid signatures and a failing audit store are all covered. The
 *      atomic audit write is verified by asserting `withTransaction` is
 *      called exactly once and `appendAudit` is invoked inside its
 *      callback (the double enforces that by observing call order via
 *      `mock.invocationCallOrder`).
 *
 * Validates: Requirements 18.2, 18.3, 18.4, 18.5, 22.1
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  DEFAULT_TOLERANCE_SECONDS,
  handleStripeWebhook,
  verifyStripeSignature,
  type StripeEvent,
  type WebhookDeps,
} from '../webhook.js';

/* ================================================================== */
/*  Shared fixtures + helpers                                          */
/* ================================================================== */

const WEBHOOK_SECRET = 'whsec_test_secret_00000000000000000000000000';
const WRONG_SECRET = 'whsec_other_secret_11111111111111111111111111';
const FIXED_EPOCH_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const FIXED_EPOCH_SEC = Math.floor(FIXED_EPOCH_MS / 1000);

/**
 * Deterministic clock used by every test that exercises
 * timestamp-sensitive code. Defaults to {@link FIXED_EPOCH_MS}.
 */
function fixedNow(atMs: number = FIXED_EPOCH_MS): () => number {
  return () => atMs;
}

/**
 * Sample Stripe event payload. Only the three top-level fields the
 * verifier reads (`id`, `type`, `data`) are inspected; `object` is
 * included so the JSON shape resembles real Stripe traffic.
 */
function samplePayload(overrides: { id?: string; type?: string; data?: unknown } = {}): string {
  return JSON.stringify({
    id: overrides.id ?? 'evt_test_1234567890',
    object: 'event',
    type: overrides.type ?? 'checkout.session.completed',
    data: overrides.data ?? {
      object: {
        id: 'cs_test_abc',
        customer: 'cus_test',
        subscription: 'sub_test',
        metadata: { studioId: 'studio-1', userId: 'user-1' },
      },
    },
  });
}

/**
 * Compute a valid HMAC-SHA256 signature for the Stripe-Signature
 * format: hex-encoded digest of `<timestamp>.<payload>` keyed by
 * the webhook secret. Same algorithm Stripe runs server-side.
 */
async function computeV1Signature(
  payload: string,
  timestampSec: number,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${String(timestampSec)}.${payload}`),
  );
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Mint a well-formed `Stripe-Signature` header containing a single
 * `v1=` signature valid for `(payload, timestamp, secret)`.
 */
async function mintHeader(payload: string, timestampSec: number, secret: string): Promise<string> {
  const sig = await computeV1Signature(payload, timestampSec, secret);
  return `t=${String(timestampSec)},v1=${sig}`;
}

/* ================================================================== */
/*  1. verifyStripeSignature — pure crypto                             */
/* ================================================================== */

describe('verifyStripeSignature', () => {
  it('accepts a well-formed signature with a fresh timestamp', async () => {
    const payload = samplePayload();
    const header = await mintHeader(payload, FIXED_EPOCH_SEC, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });

    expect(event).not.toBeNull();
    expect(event?.id).toBe('evt_test_1234567890');
    expect(event?.type).toBe('checkout.session.completed');
  });

  it('returns null for a completely malformed header', async () => {
    const payload = samplePayload();
    const event = await verifyStripeSignature(payload, 'not-a-valid-header', WEBHOOK_SECRET, {
      now: fixedNow(),
    });
    expect(event).toBeNull();
  });

  it('returns null when t= is missing', async () => {
    const payload = samplePayload();
    const sig = await computeV1Signature(payload, FIXED_EPOCH_SEC, WEBHOOK_SECRET);
    const event = await verifyStripeSignature(payload, `v1=${sig}`, WEBHOOK_SECRET, {
      now: fixedNow(),
    });
    expect(event).toBeNull();
  });

  it('returns null when no v1= signature is present', async () => {
    const payload = samplePayload();
    const event = await verifyStripeSignature(
      payload,
      `t=${String(FIXED_EPOCH_SEC)}`,
      WEBHOOK_SECRET,
      { now: fixedNow() },
    );
    expect(event).toBeNull();
  });

  it('returns null when the timestamp is stale (> 300 s in the past)', async () => {
    const payload = samplePayload();
    const stale = FIXED_EPOCH_SEC - (DEFAULT_TOLERANCE_SECONDS + 1);
    const header = await mintHeader(payload, stale, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });
    expect(event).toBeNull();
  });

  it('returns null when the timestamp is in the future (> 300 s ahead)', async () => {
    const payload = samplePayload();
    const future = FIXED_EPOCH_SEC + (DEFAULT_TOLERANCE_SECONDS + 1);
    const header = await mintHeader(payload, future, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });
    expect(event).toBeNull();
  });

  it('returns null when the signature was minted with a different secret', async () => {
    const payload = samplePayload();
    const header = await mintHeader(payload, FIXED_EPOCH_SEC, WRONG_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });
    expect(event).toBeNull();
  });

  it('returns null when the payload has been tampered with', async () => {
    // Sign payload A; submit payload B under A's signature.
    const payloadA = samplePayload({ id: 'evt_A' });
    const payloadB = samplePayload({ id: 'evt_B' });
    const header = await mintHeader(payloadA, FIXED_EPOCH_SEC, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payloadB, header, WEBHOOK_SECRET, {
      now: fixedNow(),
    });
    expect(event).toBeNull();
  });

  it('accepts the header if ANY v1= signature matches (key rotation)', async () => {
    const payload = samplePayload();
    const goodSig = await computeV1Signature(payload, FIXED_EPOCH_SEC, WEBHOOK_SECRET);
    const badSig = await computeV1Signature(payload, FIXED_EPOCH_SEC, WRONG_SECRET);
    // Two v1 entries; second one is valid.
    const header = `t=${String(FIXED_EPOCH_SEC)},v1=${badSig},v1=${goodSig}`;

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });
    expect(event).not.toBeNull();
  });

  it('returns null when the payload is not valid JSON even if HMAC matches', async () => {
    const payload = 'not-json-{{{';
    const header = await mintHeader(payload, FIXED_EPOCH_SEC, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, { now: fixedNow() });
    expect(event).toBeNull();
  });

  it('honours a custom toleranceSeconds override', async () => {
    const payload = samplePayload();
    // 10-minute-old timestamp with a 1000 s tolerance → accepted.
    const stale = FIXED_EPOCH_SEC - 600;
    const header = await mintHeader(payload, stale, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      now: fixedNow(),
      toleranceSeconds: 1000,
    });
    expect(event).not.toBeNull();
  });

  it('uses the injected now() clock for tolerance decisions', async () => {
    const payload = samplePayload();
    // Timestamp would be stale under real time, but the injected
    // clock matches it exactly → accepted.
    const stampedAt = FIXED_EPOCH_SEC - 600;
    const header = await mintHeader(payload, stampedAt, WEBHOOK_SECRET);

    const event = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      now: () => stampedAt * 1000,
    });
    expect(event).not.toBeNull();
  });
});

/* ================================================================== */
/*  2. handleStripeWebhook — happy paths                               */
/* ================================================================== */

interface DepsHandles {
  readonly verifySignature: Mock<WebhookDeps['verifySignature']>;
  readonly appendAudit: Mock<WebhookDeps['appendAudit']>;
  readonly publish: Mock<WebhookDeps['publish']>;
  /**
   * The transaction port is generic (`<T>(fn: () => Promise<T>) => Promise<T>`)
   * which `vi.fn()` cannot preserve verbatim. We type the mock with
   * the concrete shape vitest provides (`unknown` return) and the
   * handler calls it via the typed `WebhookDeps.withTransaction`
   * surface, so call-site type safety is preserved.
   */
  readonly withTransaction: Mock<(fn: () => Promise<unknown>) => Promise<unknown>>;
  readonly deps: WebhookDeps;
}

/**
 * Build a complete `WebhookDeps` bag wired to `vi.fn()` doubles.
 *
 * `withTransaction` is a pass-through by default — it invokes the
 * callback inside a Promise chain so the test can assert the order
 * of `withTransaction` vs. `appendAudit` via
 * `mock.invocationCallOrder` and confirm the audit fires inside the
 * transactional scope.
 */
function buildDeps(
  options: {
    event?: StripeEvent | null;
    appendAuditError?: Error;
    publishError?: Error;
  } = {},
): DepsHandles {
  const verifySignature = vi
    .fn<WebhookDeps['verifySignature']>()
    .mockResolvedValue(options.event ?? null);

  const appendAudit = vi.fn<WebhookDeps['appendAudit']>();
  if (options.appendAuditError !== undefined) {
    appendAudit.mockRejectedValue(options.appendAuditError);
  } else {
    appendAudit.mockResolvedValue(undefined);
  }

  const publish = vi.fn<WebhookDeps['publish']>();
  if (options.publishError !== undefined) {
    publish.mockRejectedValue(options.publishError);
  } else {
    publish.mockResolvedValue(undefined);
  }

  // Pass-through tx: runs the callback inline. Tests that need to
  // assert the tx boundary override this behaviour.
  const withTransaction = vi
    .fn<(fn: () => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (fn) => fn());

  return {
    verifySignature,
    appendAudit,
    publish,
    withTransaction,
    deps: {
      verifySignature,
      appendAudit,
      publish,
      // Narrow the mock back to the generic `WebhookDeps`
      // signature at the injection site. The mock only ever
      // invokes its callback and returns the callback's
      // resolved value, so the widening is safe.
      withTransaction: withTransaction as unknown as WebhookDeps['withTransaction'],
    },
  };
}

describe('handleStripeWebhook — happy paths', () => {
  beforeEach(() => {
    // Pin `new Date().toISOString()` so the test asserts an exact
    // `occurredAt` value in the published envelope. `useFakeTimers`
    // traps `Date.now()` AND `new Date()` whereas a plain
    // `spyOn(Date, 'now')` only traps the static call.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches checkout.session.completed as billing.subscription.started', async () => {
    const stripeEvent: StripeEvent = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          metadata: { studioId: 'studio-1' },
        },
      },
    };
    const handles = buildDeps({ event: stripeEvent });

    const outcome = await handleStripeWebhook(
      '<raw-payload>',
      't=1,v1=abc',
      WEBHOOK_SECRET,
      handles.deps,
    );

    expect(outcome).toEqual({
      kind: 'processed',
      eventType: 'checkout.session.completed',
      eventId: 'evt_checkout_1',
    });

    expect(handles.publish).toHaveBeenCalledTimes(1);
    const envelope = handles.publish.mock.calls[0]?.[0];
    expect(envelope?.type).toBe('billing.subscription.started');
    expect(envelope?.id).toBe('evt_checkout_1');
    expect(envelope?.occurredAt).toBe(new Date(FIXED_EPOCH_MS).toISOString());
    expect(envelope?.payload).toMatchObject({
      stripeEventId: 'evt_checkout_1',
      stripeEventType: 'checkout.session.completed',
    });
    expect(envelope?.payload['session']).toBe(stripeEvent.data);

    // Publish ran inside a transaction; no audit fired.
    expect(handles.withTransaction).toHaveBeenCalledTimes(1);
    expect(handles.appendAudit).not.toHaveBeenCalled();
  });

  it('dispatches customer.subscription.created as billing.subscription.started', async () => {
    const stripeEvent: StripeEvent = {
      id: 'evt_sub_created_1',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', status: 'active' } },
    };
    const handles = buildDeps({ event: stripeEvent });

    const outcome = await handleStripeWebhook('<raw>', 'sig', WEBHOOK_SECRET, handles.deps);

    expect(outcome.kind).toBe('processed');
    expect(handles.publish).toHaveBeenCalledTimes(1);
    const envelope = handles.publish.mock.calls[0]?.[0];
    expect(envelope?.type).toBe('billing.subscription.started');
    expect(envelope?.payload['subscription']).toBe(stripeEvent.data);
    expect(handles.appendAudit).not.toHaveBeenCalled();
  });

  it('dispatches invoice.payment_failed as billing.subscription.failed', async () => {
    const stripeEvent: StripeEvent = {
      id: 'evt_inv_failed_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', amount_due: 2500 } },
    };
    const handles = buildDeps({ event: stripeEvent });

    const outcome = await handleStripeWebhook('<raw>', 'sig', WEBHOOK_SECRET, handles.deps);

    expect(outcome.kind).toBe('processed');
    expect(handles.publish).toHaveBeenCalledTimes(1);
    const envelope = handles.publish.mock.calls[0]?.[0];
    expect(envelope?.type).toBe('billing.subscription.failed');
    expect(envelope?.payload['invoice']).toBe(stripeEvent.data);
    expect(handles.appendAudit).not.toHaveBeenCalled();
  });

  it('returns unknown_event_type for unhandled events and does not publish / audit', async () => {
    const stripeEvent: StripeEvent = {
      id: 'evt_unused_1',
      type: 'charge.updated',
      data: { object: { id: 'ch_1' } },
    };
    const handles = buildDeps({ event: stripeEvent });

    const outcome = await handleStripeWebhook('<raw>', 'sig', WEBHOOK_SECRET, handles.deps);

    expect(outcome).toEqual({
      kind: 'unknown_event_type',
      eventType: 'charge.updated',
    });
    expect(handles.publish).not.toHaveBeenCalled();
    expect(handles.appendAudit).not.toHaveBeenCalled();
    expect(handles.withTransaction).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  3. handleStripeWebhook — failure paths                             */
/* ================================================================== */

describe('handleStripeWebhook — signature failure', () => {
  it('returns signature_invalid and writes an audit row atomically', async () => {
    const handles = buildDeps({ event: null });

    const outcome = await handleStripeWebhook(
      '{"id":"evt_forged","type":"checkout.session.completed"}',
      't=1,v1=badsig',
      WEBHOOK_SECRET,
      handles.deps,
    );

    expect(outcome.kind).toBe('signature_invalid');
    // The failing-signature flow MUST NOT publish.
    expect(handles.publish).not.toHaveBeenCalled();

    // Audit call happened exactly once, inside a transaction.
    expect(handles.withTransaction).toHaveBeenCalledTimes(1);
    expect(handles.appendAudit).toHaveBeenCalledTimes(1);

    // withTransaction was called before appendAudit ran, i.e. the
    // audit fired inside the tx callback rather than outside of it.
    const txOrder = handles.withTransaction.mock.invocationCallOrder[0];
    const auditOrder = handles.appendAudit.mock.invocationCallOrder[0];
    expect(txOrder).toBeDefined();
    expect(auditOrder).toBeDefined();
    expect(txOrder!).toBeLessThan(auditOrder!);

    const entry = handles.appendAudit.mock.calls[0]?.[0];
    expect(entry?.action).toBe('billing.webhook.signature_failed');
    expect(entry?.targetType).toBe('stripe_webhook');
    expect(entry?.actorId).toBeNull();
    // The target id falls through to the payload's `id` field
    // (best-effort extraction) so the audit keeps a correlation
    // handle even though the signature failed.
    expect(entry?.targetId).toBe('evt_forged');
  });

  it('redacts the signature header and never logs the raw payload', async () => {
    const handles = buildDeps({ event: null });

    await handleStripeWebhook(
      '{"id":"evt_x","type":"checkout.session.completed","secret":"must-not-appear"}',
      't=1,v1=SENSITIVE-HEADER-MUST-NOT-APPEAR',
      WEBHOOK_SECRET,
      handles.deps,
    );

    const entry = handles.appendAudit.mock.calls[0]?.[0];
    expect(entry?.metadata['signatureHeader']).toBe('[REDACTED]');

    // Exhaustive sanity check: no field of the audit row leaks the
    // real header or the raw payload.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('SENSITIVE-HEADER-MUST-NOT-APPEAR');
    expect(serialised).not.toContain('must-not-appear');
  });

  it('falls back to targetId="unknown" when the payload is not JSON', async () => {
    const handles = buildDeps({ event: null });

    await handleStripeWebhook('not-json-at-all', 't=1,v1=badsig', WEBHOOK_SECRET, handles.deps);

    const entry = handles.appendAudit.mock.calls[0]?.[0];
    expect(entry?.targetId).toBe('unknown');
  });

  it('propagates an audit-append failure so the outer tx rolls back', async () => {
    const boom = new Error('db connection lost');
    const handles = buildDeps({
      event: null,
      appendAuditError: boom,
    });

    await expect(
      handleStripeWebhook(
        '{"id":"evt_x","type":"checkout.session.completed"}',
        't=1,v1=badsig',
        WEBHOOK_SECRET,
        handles.deps,
      ),
    ).rejects.toBe(boom);

    // Publish never fired — signature failure path does not
    // publish even when the audit succeeds, let alone when it
    // fails.
    expect(handles.publish).not.toHaveBeenCalled();
  });

  it('propagates a withTransaction failure (tx open error)', async () => {
    const boom = new Error('cannot open tx');
    const handles = buildDeps({ event: null });
    handles.withTransaction.mockRejectedValueOnce(boom);

    await expect(
      handleStripeWebhook('{"id":"evt_x"}', 't=1,v1=badsig', WEBHOOK_SECRET, handles.deps),
    ).rejects.toBe(boom);

    // appendAudit never ran because the tx never opened.
    expect(handles.appendAudit).not.toHaveBeenCalled();
  });
});
