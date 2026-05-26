/**
 * Stripe webhook handler — tasks 16.2 and 16.3 of the Athlya
 * implementation plan.
 *
 * ### Requirements covered
 *
 *   - **18.2** — verify every `Stripe-Signature` before processing
 *     the payload.
 *   - **18.3** — on signature verification failure, the handler MUST
 *     reject the request with HTTP 400 AND append a row to the
 *     Audit_Log **atomically**; both actions succeed together or the
 *     whole operation fails (no orphan audit, no silent reject).
 *   - **18.4** — on `customer.subscription.created`, publish
 *     `billing.subscription.started` on the event bus.
 *   - **18.5** — on `invoice.payment_failed`, publish
 *     `billing.subscription.failed` on the event bus.
 *   - **22.1** — audit row shape (`actor_id`, `action`, `target_type`,
 *     `target_id`, `metadata`).
 *
 * ### Runtime target
 *
 * The webhook endpoint runs on the same Cloudflare Workers edge as
 * the rest of the API gateway. The official `stripe` npm SDK pulls
 * in ~400 KB of Node-only modules (`crypto.createHmac`, `http`,
 * `stream`) at import time; using it on Workers means paying the
 * `nodejs_compat` bundle tax on every cold start. Since the only
 * Stripe capability this module needs is HMAC-SHA256 signature
 * verification — a dozen lines of Web Crypto — we implement it
 * directly. That keeps the billing package framework-free and the
 * edge bundle lean.
 *
 * ### Composition note (DO NOT wire to the API gateway yet)
 *
 * Stripe webhooks require a composition that differs from the
 * regular domain routes mounted in task 8.11:
 *
 *   - **Raw body preservation** — the signature is computed over the
 *     exact byte sequence Stripe transmitted, so middlewares that
 *     re-serialise JSON (Zod, `c.req.json()`) break it.
 *   - **No Turnstile** — Stripe is not a human visitor.
 *   - **No idempotency-key middleware** — Stripe dedups at its end
 *     via `event.id`; a second middleware would double-gate traffic
 *     and pollute the idempotency store with non-Athlya keys.
 *
 * This module delivers the **handler**. The route mount at
 * `POST /v1/billing/webhook` with the distinct composition above is
 * the responsibility of a later hardening task.
 *
 * ### Security notes
 *
 *   - The raw payload is **never** logged.
 *   - The `Stripe-Signature` header is redacted to `'[REDACTED]'` in
 *     audit metadata — the header encodes timing information that
 *     could help a later attacker calibrate their forged signatures,
 *     and it contributes no forensic value to the audit trail
 *     (the failure `reason` does).
 *   - Signature comparison uses `crypto.subtle.verify` which is
 *     specified as constant-time on every major runtime.
 */

/* ------------------------------------------------------------------ */
/*  Outcome                                                            */
/* ------------------------------------------------------------------ */

/**
 * Discriminated outcomes of {@link handleStripeWebhook}.
 *
 *   - `'processed'`          — signature valid, event dispatched
 *                              (or a no-op for an event type we do
 *                              not care about); the HTTP layer
 *                              returns 200. `eventId` lets the
 *                              gateway log correlate back to Stripe.
 *   - `'signature_invalid'`  — signature verification failed; the
 *                              HTTP layer returns 400 and the audit
 *                              row has already been written inside
 *                              the same transaction.
 *   - `'unknown_event_type'` — signature valid but the event type
 *                              is not one the billing service cares
 *                              about (e.g. `charge.updated`). No
 *                              publish, no audit; the HTTP layer
 *                              returns 200 so Stripe stops retrying.
 *
 * HTTP serialisation is the caller's concern — this union keeps the
 * handler pure and independently testable.
 */
export type WebhookOutcome =
  | {
      readonly kind: 'processed';
      readonly eventType: string;
      readonly eventId: string;
    }
  | {
      readonly kind: 'signature_invalid';
      readonly reason: SignatureFailureReason;
    }
  | {
      readonly kind: 'unknown_event_type';
      readonly eventType: string;
    };

/**
 * Structured reason tag for a signature failure. Kept as a closed
 * union so the caller can emit a consistent metrics label without
 * free-form string parsing.
 *
 *   - `'malformed_header'` — the `Stripe-Signature` header did not
 *                            parse into `{ t=…, v1=… }`.
 *   - `'timestamp_stale'`  — the `t=…` timestamp is outside the
 *                            tolerance window (default ±300 s).
 *   - `'hmac_mismatch'`    — every `v1=…` signature in the header
 *                            failed HMAC-SHA256 verification.
 *   - `'malformed_payload'` — HMAC succeeded but the payload is not
 *                             valid JSON or lacks `id` / `type`.
 */
export type SignatureFailureReason =
  | 'malformed_header'
  | 'timestamp_stale'
  | 'hmac_mismatch'
  | 'malformed_payload';

/* ------------------------------------------------------------------ */
/*  Parsed event                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal projection of a Stripe event — the three fields this
 * handler actually reads. The `data` field is deliberately `unknown`
 * so each downstream branch narrows the shape it needs; we never
 * validate Stripe's full schema here.
 */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

/* ------------------------------------------------------------------ */
/*  Dependency bag                                                     */
/* ------------------------------------------------------------------ */

/**
 * Audit entry shape accepted by {@link WebhookDeps.appendAudit}.
 *
 * Mirrors the contract of `packages/api/src/audit.ts` (`AuditEntry`)
 * but is redeclared here to keep `@athlya/billing` framework-free
 * and avoid a dependency on the API gateway package.
 *
 *   - `actorId`    — `null` for machine actors (Stripe). RGPD
 *                    anonymisation already relies on nullable actor.
 *   - `action`     — stable slug; Requirement 22.1 wires
 *                    `billing.webhook.signature_failed` for this
 *                    path.
 *   - `targetType` — coarse entity label (`stripe_webhook`).
 *   - `targetId`   — opaque stable id (Stripe event id when we can
 *                    extract it, otherwise the literal
 *                    `'unknown'`).
 *   - `metadata`   — free-form JSON context. The handler redacts
 *                    the raw signature header to `'[REDACTED]'` and
 *                    never logs the payload.
 */
export interface WebhookAuditEntry {
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Event envelope the handler hands to {@link WebhookDeps.publish}.
 *
 * Intentionally looser than `AthlyaEvent` in `@athlya/shared` so the
 * billing package stays decoupled from the shared discriminated
 * union: the wiring layer (outside this package) adapts the envelope
 * to the concrete `publish(event, tx, deps)` signature from
 * `packages/api/src/events/publish.ts`.
 */
export interface WebhookPublishEnvelope {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly studioId?: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Discriminated result of {@link verifyStripeSignature} and
 * {@link WebhookDeps.verifySignature}.
 *
 *   - `{ ok: true, event }` — signature valid; event is ready for
 *     dispatch.
 *   - `{ ok: false, reason }` — verification failed; the specific
 *     reason is propagated to the audit row so ops can distinguish
 *     clock-drift (`timestamp_stale`), proxy misconfiguration
 *     (`malformed_header`), and actual forgery attempts
 *     (`hmac_mismatch`) in automated alerting (issue #56).
 */
export type VerifyResult =
  | { readonly ok: true; readonly event: StripeEvent }
  | { readonly ok: false; readonly reason: SignatureFailureReason };

/**
 * Ports {@link handleStripeWebhook} delegates to. Every field is
 * injected so the handler is framework-free and trivially
 * unit-testable with `vi.fn()` doubles.
 *
 *   - `verifySignature` — verifies the `Stripe-Signature` header
 *                         against `rawPayload` using `webhookSecret`.
 *                         Returns a {@link VerifyResult}: `ok: true`
 *                         with the parsed event on success, or
 *                         `ok: false` with the structured failure
 *                         reason on any error. The default wiring
 *                         uses {@link verifyStripeSignature}; tests
 *                         inject deterministic stubs.
 *   - `appendAudit`     — append a row to the audit log. MUST run
 *                         in the same DB transaction as any state
 *                         writes / publishes that accompany it;
 *                         {@link WebhookDeps.withTransaction} is
 *                         responsible for providing that scope.
 *   - `publish`         — push an event onto the bus. MUST run
 *                         inside a transaction (so an outbox
 *                         fallback can commit atomically with the
 *                         caller's state changes).
 *   - `withTransaction` — transactional scope. The handler calls it
 *                         once per write path (audit write, publish,
 *                         …); the wiring layer opens a DB tx and
 *                         commits it if the callback resolves or
 *                         rolls back if it throws.
 */
export interface WebhookDeps {
  readonly verifySignature: (
    payload: string,
    signatureHeader: string,
    secret: string,
  ) => Promise<VerifyResult>;
  readonly appendAudit: (entry: WebhookAuditEntry) => Promise<void>;
  readonly publish: (event: WebhookPublishEnvelope) => Promise<void>;
  readonly withTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Stripe-Signature primitives                                         */
/* ------------------------------------------------------------------ */

/**
 * Default replay protection window, in seconds. Matches Stripe's
 * recommendation ("We recommend 5 minutes" — Stripe docs).
 *
 * The window is symmetric: a timestamp in the future by more than
 * this value is also rejected, which guards against a clock-skew
 * attacker who pre-computes a valid signature for a timestamp the
 * server has not reached yet.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Options accepted by {@link verifyStripeSignature}. */
export interface VerifyStripeSignatureOptions {
  /**
   * Clock used for timestamp tolerance. Defaults to
   * `() => Date.now()`. Tests inject a deterministic clock.
   */
  readonly now?: () => number;
  /**
   * Maximum absolute skew between the header's `t=` field and
   * `now()`, in seconds. Defaults to
   * {@link DEFAULT_TOLERANCE_SECONDS}.
   */
  readonly toleranceSeconds?: number;
}

/**
 * Parsed representation of a `Stripe-Signature` header.
 *
 *   - `timestamp` is the Unix epoch in seconds from the `t=` field.
 *   - `v1Signatures` contains every `v1=` value in the header — Stripe
 *     emits multiple during webhook secret rotation, and any single
 *     match counts as verification success.
 */
interface ParsedSignatureHeader {
  readonly timestamp: number;
  readonly v1Signatures: readonly string[];
}

/**
 * Parse a `Stripe-Signature` header string into its `t=` timestamp
 * and the list of `v1=` signatures.
 *
 * Returns `null` for any malformation — missing `t`, zero `v1`
 * signatures, non-integer timestamp, unexpected field shape. Callers
 * turn this `null` into a `malformed_header` failure reason.
 */
function parseStripeSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (header.length === 0) {
    return null;
  }
  let timestamp: number | null = null;
  const v1Signatures: string[] = [];

  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) {
      return null;
    }
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (value.length === 0) {
      return null;
    }

    if (key === 't') {
      if (!/^[0-9]+$/.test(value)) {
        return null;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      timestamp = parsed;
    } else if (key === 'v1') {
      // v1 is a hex-encoded HMAC-SHA256 → 64 hex chars. Reject
      // anything that is not purely hex to short-circuit
      // `hexDecode` below for obviously malformed signatures.
      if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
        return null;
      }
      v1Signatures.push(value);
    }
    // Other schemes (`v0`, future `v2`, …) are ignored per
    // Stripe's documentation.
  }

  if (timestamp === null || v1Signatures.length === 0) {
    return null;
  }

  return { timestamp, v1Signatures };
}

/** Decode a strictly-hex string into bytes. Returns `null` on error. */
function hexDecode(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const hi = hexCharToNibble(hex.charCodeAt(i));
    const lo = hexCharToNibble(hex.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) {
      return null;
    }
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

/** Map an ASCII hex character code to its 4-bit value, or -1 on error. */
function hexCharToNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F
  return -1;
}

/**
 * Verify a raw webhook payload against its `Stripe-Signature` header.
 *
 * Contract
 * --------
 * Returns a {@link VerifyResult} discriminated union:
 *
 *   - `{ ok: true, event }` — every step succeeded; the caller
 *     proceeds with the parsed event.
 *   - `{ ok: false, reason }` — one step failed; reason is one of
 *     `'malformed_header'`, `'timestamp_stale'`, `'hmac_mismatch'`,
 *     or `'malformed_payload'`. The caller turns this into a 400.
 *
 *   1. **Header parse.** `t=<timestamp>,v1=<sig>[,v1=<sig2>…]` —
 *      any other shape → `malformed_header`.
 *   2. **Timestamp tolerance.** `|now − t| ≤ toleranceSeconds`
 *      (default 300 s). The check is symmetric so a future-dated
 *      timestamp is rejected too. Failure → `timestamp_stale`.
 *   3. **HMAC-SHA256.** Using `webhookSecret` as the key and
 *      `<timestamp>.<rawPayload>` as the message. Every `v1=` in
 *      the header is compared in turn; a single match counts as
 *      success. `crypto.subtle.verify` is specified as constant-time
 *      across every major runtime (Node 20, Workers, browsers).
 *      Failure → `hmac_mismatch`.
 *   4. **JSON parse.** The raw payload is `JSON.parse`-d and the
 *      resulting object must carry `id: string` and `type: string`.
 *      Anything else → `malformed_payload`.
 *
 * Thread-safety: the function allocates fresh buffers per call and
 * imports the HMAC key locally; no shared state.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  opts: VerifyStripeSignatureOptions = {},
): Promise<VerifyResult> {
  const now = opts.now ?? (() => Date.now());
  const toleranceSeconds = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  // 1. Header parse.
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (parsed === null) {
    return { ok: false, reason: 'malformed_header' };
  }

  // 2. Timestamp tolerance. `t` is epoch seconds; `now()` is ms.
  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_stale' };
  }

  // 3. HMAC-SHA256 verification.
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const signedPayload = `${String(parsed.timestamp)}.${payload}`;
  const dataBytes = encoder.encode(signedPayload);

  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'verify',
    ]);
  } catch {
    // An empty secret (or a host without Web Crypto) cannot
    // import. Treat as verification failure rather than throwing
    // so the caller's audit path fires.
    return { ok: false, reason: 'hmac_mismatch' };
  }

  let anyMatch = false;
  for (const sigHex of parsed.v1Signatures) {
    const sigBytes = hexDecode(sigHex);
    if (sigBytes === null) {
      continue;
    }
    // `verify` is specified as constant-time.
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      // `crypto.subtle.verify` accepts a BufferSource. The
      // narrowed `Uint8Array` is one. The `.buffer` projection
      // is avoided on purpose — SharedArrayBuffer shenanigans
      // only bite when you go there.
      sigBytes,
      dataBytes,
    );
    if (ok) {
      anyMatch = true;
      // Don't early-break: iterating every signature keeps the
      // total time independent of which signature matched,
      // avoiding a timing side channel on the v1 list order.
    }
  }
  if (!anyMatch) {
    return { ok: false, reason: 'hmac_mismatch' };
  }

  // 4. JSON parse and shape check.
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'malformed_payload' };
  }
  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  const type = obj['type'];
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, reason: 'malformed_payload' };
  }

  return {
    ok: true,
    event: { id, type, data: obj['data'] },
  };
}

/* ------------------------------------------------------------------ */
/*  Handler                                                            */
/* ------------------------------------------------------------------ */

/**
 * Action slug written to the audit log when signature verification
 * fails. Stable string — Requirement 22.1 wires this slug for the
 * webhook signature failure path.
 */
const AUDIT_ACTION_SIGNATURE_FAILED = 'billing.webhook.signature_failed';

/** Target type tag for audit rows emitted by this handler. */
const AUDIT_TARGET_TYPE = 'stripe_webhook';

/** Placeholder used when the event id cannot be extracted. */
const AUDIT_TARGET_UNKNOWN = 'unknown';

/** Stripe event types dispatched to the event bus. */
const EVENT_CHECKOUT_COMPLETED = 'checkout.session.completed';
const EVENT_SUBSCRIPTION_CREATED = 'customer.subscription.created';
const EVENT_INVOICE_PAYMENT_FAILED = 'invoice.payment_failed';

/** Athlya event types published to the bus. */
const PUB_SUBSCRIPTION_STARTED = 'billing.subscription.started';
const PUB_SUBSCRIPTION_FAILED = 'billing.subscription.failed';

/**
 * Best-effort extraction of a Stripe event id from a raw payload,
 * for use as the audit row's `targetId` when signature verification
 * has already failed (so we cannot trust the payload, but we can
 * still capture a correlation handle when the payload is JSON).
 *
 * Returns {@link AUDIT_TARGET_UNKNOWN} when no id is present.
 */
function tryExtractEventId(rawPayload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return AUDIT_TARGET_UNKNOWN;
  }
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
    return AUDIT_TARGET_UNKNOWN;
  }
  const { id } = parsed;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return AUDIT_TARGET_UNKNOWN;
  }
  return id;
}

/**
 * Handle an incoming Stripe webhook.
 *
 * High-level flow:
 *
 *   1. **Verify** `signatureHeader` against `rawPayload` using
 *      `webhookSecret`. On failure, atomically append an audit row
 *      (within a transaction) and return `{ kind: 'signature_invalid' }`.
 *   2. **Dispatch** by `event.type`:
 *        - `checkout.session.completed`     → publish `billing.subscription.started`.
 *        - `customer.subscription.created`  → publish `billing.subscription.started`.
 *        - `invoice.payment_failed`         → publish `billing.subscription.failed`.
 *        - anything else                    → `{ kind: 'unknown_event_type' }`.
 *      Publishes run inside `withTransaction` so the outbox fallback
 *      (when the downstream queue is down) commits with whatever
 *      state writes the wiring layer eventually plugs in.
 *
 * Error propagation: any thrown error from `appendAudit`, `publish`
 * or `withTransaction` bubbles up unchanged. The gateway's outer
 * handler maps it to HTTP 500; Stripe will retry.
 *
 * No HTTP-specific concerns — this function returns a typed
 * outcome, never writes headers or bodies.
 */
export async function handleStripeWebhook(
  rawPayload: string,
  signatureHeader: string,
  webhookSecret: string,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  // Step 1 — verify signature. A failed result triggers the audit path.
  const verifyResult = await deps.verifySignature(rawPayload, signatureHeader, webhookSecret);

  if (!verifyResult.ok) {
    // Requirement 18.3 — reject + audit atomically. We keep the
    // audit inside a transaction so the wiring layer can combine
    // it with any additional state writes (not needed today) or
    // guarantee the commit ordering.
    //
    // The structured reason distinguishes clock-drift
    // (`timestamp_stale`), proxy misconfiguration
    // (`malformed_header`), and actual forgery attempts
    // (`hmac_mismatch`) so automated alerting can page
    // appropriately (issue #56).
    const reason = verifyResult.reason;
    const targetId = tryExtractEventId(rawPayload);

    await deps.withTransaction(async () => {
      await deps.appendAudit({
        actorId: null,
        action: AUDIT_ACTION_SIGNATURE_FAILED,
        targetType: AUDIT_TARGET_TYPE,
        targetId,
        metadata: {
          reason,
          // The `Stripe-Signature` header carries timing
          // data; it contributes no forensic value beyond
          // the reason, so we redact it. The raw payload is
          // never logged.
          signatureHeader: '[REDACTED]',
        },
      });
    });

    return { kind: 'signature_invalid', reason };
  }

  // Step 2 — dispatch by event type.
  const { event } = verifyResult;
  const occurredAt = new Date().toISOString();

  switch (event.type) {
    case EVENT_CHECKOUT_COMPLETED: {
      await deps.withTransaction(async () => {
        await deps.publish({
          id: event.id,
          type: PUB_SUBSCRIPTION_STARTED,
          occurredAt,
          payload: {
            stripeEventId: event.id,
            stripeEventType: event.type,
            session: event.data,
          },
        });
      });
      return {
        kind: 'processed',
        eventType: event.type,
        eventId: event.id,
      };
    }

    case EVENT_SUBSCRIPTION_CREATED: {
      await deps.withTransaction(async () => {
        await deps.publish({
          id: event.id,
          type: PUB_SUBSCRIPTION_STARTED,
          occurredAt,
          payload: {
            stripeEventId: event.id,
            stripeEventType: event.type,
            subscription: event.data,
          },
        });
      });
      return {
        kind: 'processed',
        eventType: event.type,
        eventId: event.id,
      };
    }

    case EVENT_INVOICE_PAYMENT_FAILED: {
      await deps.withTransaction(async () => {
        await deps.publish({
          id: event.id,
          type: PUB_SUBSCRIPTION_FAILED,
          occurredAt,
          payload: {
            stripeEventId: event.id,
            stripeEventType: event.type,
            invoice: event.data,
          },
        });
      });
      return {
        kind: 'processed',
        eventType: event.type,
        eventId: event.id,
      };
    }

    default: {
      // Stripe emits plenty of events we don't care about
      // (`charge.updated`, `customer.updated`, …). Treat them
      // as a no-op so Stripe stops retrying the delivery.
      return { kind: 'unknown_event_type', eventType: event.type };
    }
  }
}
