/**
 * Notifications consumer for Athlya — task 9.5 of the implementation
 * plan.
 *
 * This module is the single entry point the event-bus plumbing calls
 * with a typed {@link AthlyaEvent}. It handles the five event types
 * listed in Requirement 17 and design.md §"Component 5 —
 * Notifications Service":
 *
 *   - `reservation.created`            → booking confirmation (email + push)
 *   - `reservation.reminder`           → 1 h reminder (push)
 *   - `reservation.cancelled`          → cancellation notice (email + push)
 *   - `reservation.promoted`           → "you're in!" notice (email + push)
 *   - `billing.subscription.failed`    → dunning email (email)
 *
 * All five are *transactional* per Requirement 17.2 — they always ship
 * regardless of `consents.marketing`. The consent-gating code path is
 * still exercised here (and returns `'skipped_no_consent'`) so adding
 * a marketing event later is a one-line change to the routing table.
 *
 * ### Non-responsibilities
 *
 *   - Scheduling the 1 h reminder job on QStash is task 9.6 — this
 *     consumer only *handles* the `reservation.reminder` event once it
 *     fires.
 *   - Writing / parsing the envelope: upstream callers (the Cloudflare
 *     Queues worker, the DLQ replay script, the QStash webhook
 *     handler) call `parseEvent` from `@athlya/shared/events` and hand
 *     a typed {@link AthlyaEvent} in.
 *   - Retry / DLQ: Cloudflare Queues owns the retry budget; a thrown
 *     error from {@link handleEvent} surfaces as a message-level
 *     failure and the queue's DLQ policy (Requirement 16.5) takes
 *     over.
 *
 * ### Ports
 *
 * The consumer is framework-free and depends on ports declared in
 * this file. Production wires them to:
 *
 *   - `DedupStore`   → Upstash Redis `SET NX EX 86400` on
 *                      `notifications:seen:{eventId}` (Requirement 17.4).
 *   - `RecipientRepo` → `SELECT ... FROM users WHERE id = $1` through
 *                      the members service (fetched with the system
 *                      role — notifications are background jobs).
 *   - `EmailSender`  → Resend SDK.
 *   - `PushSender`   → Expo Push SDK (`expo-server-sdk`).
 *   - `Clock`        → `() => Date.now()`.
 *   - `Logger`       → request-scoped tracing logger.
 *
 * Unit tests replace every port with `vi.fn()` so the suite never
 * imports Redis / Resend / Expo / Drizzle.
 *
 * ### Templates and i18n (Req 28.3)
 *
 * Every user-facing subject, body, title and body string rendered by
 * this consumer is sourced from `@athlya/shared/i18n` under the
 * `notifications.*` namespace — no hard-coded literals live in this
 * module. Adding a new event type requires:
 *
 *   1. Adding matching keys (email.subject, email.body, push.title,
 *      push.body — any subset that applies) to **both**
 *      `packages/shared/src/i18n/fr.json` AND `en.json`.
 *   2. Updating {@link HANDLED_EVENT_TYPES},
 *      {@link TRANSACTIONAL_KIND} and the {@link render} dispatcher.
 *
 * The parity test in `__tests__/i18n-keys.test.ts` enumerates every
 * expected key and asserts both bundles contain them, so a missing
 * translation fails CI before production rollout.
 *
 * Related requirements: 17.1, 17.2, 17.3 (consumed, not scheduled),
 * 17.4, 28.3.
 */

import { t, type Locale } from '@athlya/shared/i18n';
import { isNotificationEnabled } from '@athlya/shared/schemas/api';

import type {
  AthlyaEvent,
  BillingSubscriptionFailedEvent,
  ReservationCancelledEvent,
  ReservationCreatedEvent,
  ReservationPromotedEvent,
  ReservationReminderEvent,
} from '@athlya/shared/events';
import type { Consents } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Dedup TTL in seconds. Requirement 17.4 mandates exactly 24 h —
 * long enough to cover a Cloudflare Queues redelivery storm, short
 * enough that an operator can replay an event on day 2 for a fix.
 */
export const DEDUP_TTL_SECONDS = 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/*  Recipient                                                          */
/* ------------------------------------------------------------------ */

/**
 * The minimal projection the consumer needs about the recipient of a
 * notification. Produced by {@link RecipientRepo} — usually sourced
 * from the `users` row plus the `push_tokens` table joined on
 * `user_id`.
 *
 *   - `userId`       — echoed back to the logger for correlation.
 *   - `email`        — nullable to cover the `deletedAt IS NOT NULL`
 *                       path: a user scheduled for deletion may still
 *                       have a reservation reminder in-flight.
 *   - `pushTokens`   — the full active list. An empty array skips the
 *                       push leg silently.
 *   - `consents`     — full record including the version, used for
 *                       audit logging on the Notifications service
 *                       side (Requirement 22.1 — upstream of this
 *                       module).
 *   - `locale`       — drives template selection. Defaults to `'fr'`
 *                       when the field is missing on the DB row (the
 *                       MVP locale).
 */
export interface Recipient {
  readonly userId: string;
  readonly email: string | null;
  readonly pushTokens: readonly string[];
  readonly consents: Consents;
  readonly locale: 'fr' | 'en';
}

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Dedup store contract (Requirement 17.4).
 *
 * Sprint 11 / Slice 11.1 (critique C2.4) — historically this port
 * exposed `hasSeen()` + `markSeen()` separately. The contract was
 * documented as "implementations MUST be atomic on a per-key basis"
 * but the shape allowed non-atomic implementations to compile, which
 * defeated the point. Two concurrent Cloudflare Queue workers picking
 * up the same redelivered message would both see `hasSeen() === false`
 * and both fire the email. The fix replaces the pair with a single
 * `tryAcquire(eventId, ttlSec)` method whose contract IS atomic at
 * the type level.
 *
 * Production implementation: Upstash Redis
 * `SET notifications:seen:{eventId} 1 NX EX 86400`. The `NX` flag
 * makes the operation atomic; the boolean reply is the
 * "first-writer-wins" decision. A second worker reading the same
 * `eventId` gets `false` and short-circuits the dispatch chain.
 *
 * `release()` complements `tryAcquire()` for the failure path:
 * Cloudflare Queues delivers at-least-once, so a thrown sender error
 * MUST surface as a queue redelivery. Without `release()`, the claim
 * persists for the full TTL and every retry returns `'skipped_duplicate'`.
 * The consumer wraps the dispatch chain in `try { … } catch (err) {
 * await dedup.release(event.id); throw err; }`.
 */
export interface DedupStore {
  /**
   * Atomically claim `eventId` for `ttlSec` seconds. Returns
   * `true` if this caller is the first writer (and the event is
   * now persisted as seen). Returns `false` if another worker
   * already claimed the same id within the TTL window.
   *
   * The implementation MUST be atomic at the storage level —
   * a `GET` + `SET` pair would re-introduce the race the
   * single-call shape exists to prevent. With Upstash Redis,
   * use `SET key value NX EX ttl` and treat the reply (`'OK'`
   * or `null`) as the first-writer signal.
   */
  tryAcquire(eventId: string, ttlSec: number): Promise<boolean>;

  /**
   * Drop a previously-acquired claim so a redelivered event can
   * be re-processed. Called by the consumer's `catch` arm when a
   * sender throws — the queue redelivery semantics guarantee a
   * later worker will pick the same `eventId` up.
   *
   * Idempotent: calling `release()` on a key that has already
   * expired (or was never claimed) MUST NOT throw. With Upstash
   * Redis, a plain `DEL` is sufficient — the response is the
   * count of keys removed and is not inspected.
   */
  release(eventId: string): Promise<void>;
}

/**
 * Recipient lookup contract. Implementations return `null` when the
 * user no longer exists (`deleted_at IS NOT NULL` and the row has
 * been anonymised beyond usefulness, or the row was purged on RGPD
 * cascade — Requirement 5). The consumer surfaces `null` as
 * `'skipped_no_recipient'`.
 */
export interface RecipientRepo {
  getRecipient(userId: string): Promise<Recipient | null>;
}

/**
 * Preference lookup contract (issue #762). Returns the stored
 * preferences of the recipient (channels turned off per message), or
 * `null` when there are none; every channel is then on. Production reads
 * them through the `notification_preferences_of` service function
 * (migration 0054).
 */
export interface PreferencesRepo {
  getPreferences(userId: string): Promise<unknown>;
}

/** Arguments accepted by {@link EmailSender.send}. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Email delivery port. Implementations MUST throw on transient
 * Resend / SMTP failures so Cloudflare Queues can retry; a
 * permanently invalid address SHOULD surface as a logged warning
 * only (but this module does not enforce that — it leaves the
 * policy to the adapter).
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Arguments accepted by {@link PushSender.send}. */
export interface PushMessage {
  readonly tokens: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, string>;
}

/**
 * Push delivery port. The adapter is expected to fan out one ticket
 * per token and surface per-token failures back to the caller — this
 * consumer does not inspect the result, it relies on the adapter for
 * DeviceNotRegistered housekeeping (token pruning is task 17.5 at the
 * infrastructure level, out of scope here).
 */
export interface PushSender {
  send(message: PushMessage): Promise<void>;
}

/**
 * Minimal logger shape — mirrors `@athlya/api/events/drain-worker`'s
 * `Logger` interface so infrastructure packages can share an
 * implementation. All methods accept an optional `meta` object for
 * structured fields (`eventId`, `userId`, …).
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Injectable clock. `number` is Unix-ms to match `Date.now()` and
 * the shape used by `@athlya/reservations/checkin`. Defaults to
 * `Date.now` in production.
 */
export type Clock = () => number;

/* ------------------------------------------------------------------ */
/*  Result type                                                        */
/* ------------------------------------------------------------------ */

/**
 * Possible outcomes of a single event handling.
 *
 *   - `'skipped_duplicate'`    — the event id was already in the
 *     dedup store. No sender was called, no state change.
 *   - `'skipped_no_recipient'` — the recipient was removed from the
 *     database (RGPD cascade or the user never existed). No state
 *     change; the event id is NOT marked as seen so a future replay
 *     after a data restore still fires.
 *   - `'skipped_no_consent'`   — reserved for future marketing
 *     events. Never currently returned because all four handled
 *     events are transactional (Requirement 17.2). Kept as an arm so
 *     consumers can pattern-match exhaustively.
 *   - `'ok'`                   — at least one sender completed. The
 *     `email` / `push` booleans indicate which legs ran; a leg that
 *     was skipped because the recipient had no address / no tokens
 *     reports `false`.
 */
export type HandleResult =
  | { readonly status: 'skipped_duplicate' }
  | { readonly status: 'skipped_no_recipient' }
  | { readonly status: 'skipped_no_consent' }
  | {
      readonly status: 'ok';
      readonly email: boolean;
      readonly push: boolean;
    };

/* ------------------------------------------------------------------ */
/*  Dependency bag                                                     */
/* ------------------------------------------------------------------ */

/** Dependency bag accepted by {@link handleEvent}. */
export interface HandleEventDeps {
  readonly dedup: DedupStore;
  readonly recipients: RecipientRepo;
  readonly email: EmailSender;
  readonly push: PushSender;
  readonly logger: Logger;
  /** Optional: without it every channel of every message is on. */
  readonly preferences?: PreferencesRepo;
  /** Optional — defaults to `Date.now`. Tests pin it for determinism. */
  readonly clock?: Clock;
  /**
   * Optional override for the transactional / marketing classifier.
   *
   * All four event types handled today are transactional per the
   * built-in {@link TRANSACTIONAL_KIND} table, so in production this
   * port is not wired. Unit tests pass a stub to exercise the
   * marketing / consent-gated branch (Requirement 17.1) without
   * needing to first land a real marketing event type in
   * `@athlya/shared/events`. When present, the function is called
   * with the already-narrowed handled event type and its return
   * value overrides the built-in lookup: `true` means "ship
   * regardless of consents.marketing" (Req 17.2), `false` means
   * "require consents.marketing = true" (Req 17.1).
   */
  readonly isTransactional?: (eventType: string) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Routing table                                                      */
/* ------------------------------------------------------------------ */

/**
 * Subset of event types the Notifications consumer currently handles.
 * An inbound event whose `type` is not in this tuple is ignored (and
 * returned as `'skipped_no_consent'` only if it was a marketing type;
 * unknown / unrelated types are silently acknowledged with `'ok'`
 * + no sends). Keeping the tuple exported lets routers filter at the
 * queue-binding level without importing every arm individually.
 */
export const HANDLED_EVENT_TYPES = [
  'reservation.created',
  'reservation.reminder',
  'reservation.cancelled',
  'reservation.promoted',
  'billing.subscription.failed',
] as const;

type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/**
 * Every handled event today is transactional per Requirement 17.2.
 * This map is kept as a lookup rather than a hard-coded `true` so a
 * future `reservation.newsletter` event can flip to `false` and
 * exercise the `'skipped_no_consent'` branch without touching the
 * dispatch code.
 */
const TRANSACTIONAL_KIND: Readonly<Record<HandledEventType, boolean>> = {
  'reservation.created': true,
  'reservation.reminder': true,
  'reservation.cancelled': true,
  'reservation.promoted': true,
  'billing.subscription.failed': true,
};

/**
 * Key of each handled event in `MEMBER_NOTIFICATION_CATALOG`, the
 * namespace member preferences are stored under. The catalog marks
 * `billingSubscriptionFailed` as mandatory, so no preference ever stops
 * it.
 */
const PREFERENCE_KEY: Readonly<Record<HandledEventType, string>> = {
  'reservation.created': 'reservationCreated',
  'reservation.reminder': 'reservationReminder',
  'reservation.cancelled': 'reservationCancelled',
  'reservation.promoted': 'reservationPromoted',
  'billing.subscription.failed': 'billingSubscriptionFailed',
};

/* ------------------------------------------------------------------ */
/*  Templates                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rendered template for one event / locale pair.
 *
 *   - `emailSubject` / `emailBody` — when both are present the email
 *     leg runs (subject + HTML body derived from the plain text).
 *   - `pushTitle` / `pushBody`     — when both are present the push
 *     leg runs.
 *   - `pushData`                   — deep-link metadata attached to
 *     the Expo push, already stringified so the transport cast to
 *     `Record<string, string>` is safe.
 *
 * Any leg that is not relevant for the event (e.g. billing-failed has
 * no push) is omitted — absence is what drives the "email-only" or
 * "push-only" behaviour described in the task.
 */
interface RenderedMessage {
  readonly emailSubject?: string | undefined;
  readonly emailBody?: string | undefined;
  readonly pushTitle?: string | undefined;
  readonly pushBody?: string | undefined;
  readonly pushData?: Record<string, string> | undefined;
}

/**
 * Pick the localised copy for `(event, locale)`. Kept as a single
 * dispatcher so the routing logic below stays event-type-agnostic.
 *
 * Copy is resolved from `@athlya/shared/i18n` under the `notifications.*`
 * namespace (FR is the product default, EN is the guaranteed fallback).
 * Per-event placeholders (`{reservationId}`, `{subscriptionId}`,
 * `{reason}`) are interpolated by the helper. See Requirement 28.3 — all
 * user-facing strings live in `packages/shared/i18n`, no hard-coded
 * literals in this module.
 *
 * Adding a new event type:
 *   1. Add its templates under a new `notifications.<event>` key in
 *      **both** `packages/shared/src/i18n/fr.json` AND `en.json` — the
 *      parity test in `__tests__/i18n-keys.test.ts` guards against
 *      drift.
 *   2. Extend {@link HANDLED_EVENT_TYPES} and
 *      {@link TRANSACTIONAL_KIND} with the new type.
 *   3. Add a `case` branch below that resolves the subject / body /
 *      title / body strings from the new i18n keys. Keep the
 *      `pushData` field — it is deep-link metadata, not a UI string.
 */
function render(event: AthlyaEvent, locale: Locale): RenderedMessage {
  switch (event.type) {
    case 'reservation.created':
      return renderReservationCreated(event, locale);
    case 'reservation.reminder':
      return renderReservationReminder(event, locale);
    case 'reservation.cancelled':
      return renderReservationCancelled(event, locale);
    case 'reservation.promoted':
      return renderReservationPromoted(event, locale);
    case 'billing.subscription.failed':
      return renderBillingFailed(event, locale);
    default:
      // Any non-handled event type falls through to an empty
      // template; the caller decides what to do with it.
      return {};
  }
}

function renderReservationCreated(event: ReservationCreatedEvent, locale: Locale): RenderedMessage {
  const { reservationId, classId } = event.payload;
  return {
    emailSubject: t('notifications.reservationCreated.email.subject', locale),
    emailBody: t('notifications.reservationCreated.email.body', locale, {
      reservationId,
    }),
    pushTitle: t('notifications.reservationCreated.push.title', locale),
    pushBody: t('notifications.reservationCreated.push.body', locale),
    pushData: { reservationId, classId, type: event.type },
  };
}

function renderReservationReminder(
  event: ReservationReminderEvent,
  locale: Locale,
): RenderedMessage {
  const { reservationId, classId, startsAt } = event.payload;
  // Reminder is push-only by design (design.md §Component 5) —
  // sending a reminder email 1 h before class would compete with
  // the confirmation email and hit inbox-placement limits on Resend
  // free tier.
  return {
    pushTitle: t('notifications.reservationReminder.push.title', locale),
    pushBody: t('notifications.reservationReminder.push.body', locale),
    pushData: { reservationId, classId, startsAt, type: event.type },
  };
}

function renderReservationCancelled(
  event: ReservationCancelledEvent,
  locale: Locale,
): RenderedMessage {
  const { reservationId, classId } = event.payload;
  return {
    emailSubject: t('notifications.reservationCancelled.email.subject', locale),
    emailBody: t('notifications.reservationCancelled.email.body', locale, {
      reservationId,
    }),
    pushTitle: t('notifications.reservationCancelled.push.title', locale),
    pushBody: t('notifications.reservationCancelled.push.body', locale),
    pushData: { reservationId, classId, type: event.type },
  };
}

/**
 * `reservation.promoted` — emitted when a waitlisted member is
 * promoted to `confirmed` after a cancellation frees a slot
 * (Requirement 9.3, 10.3). The member is expecting a class spot and
 * needs to know immediately, so the notification is classified as
 * transactional (Req 17.2, mirroring `reservation.created`): the
 * consent.marketing flag is intentionally ignored.
 *
 * Email + push are both rendered — the email acts as the durable
 * proof of booking while the push is the timely nudge. Payload
 * shape mirrors the other reservation lifecycle renders so any
 * downstream deep-link handler can treat the four `reservation.*`
 * push types uniformly.
 */
function renderReservationPromoted(
  event: ReservationPromotedEvent,
  locale: Locale,
): RenderedMessage {
  const { reservationId, classId } = event.payload;
  return {
    emailSubject: t('notifications.reservationPromoted.email.subject', locale),
    emailBody: t('notifications.reservationPromoted.email.body', locale, {
      reservationId,
    }),
    pushTitle: t('notifications.reservationPromoted.push.title', locale),
    pushBody: t('notifications.reservationPromoted.push.body', locale),
    pushData: { reservationId, classId, type: event.type },
  };
}

function renderBillingFailed(
  event: BillingSubscriptionFailedEvent,
  locale: Locale,
): RenderedMessage {
  const { subscriptionId, reason } = event.payload;
  // Billing-failed is email-only. A push that says "your payment
  // failed" would fire on every device including a spouse's phone
  // with a shared Apple ID; email is the right channel for
  // financial notices.
  return {
    emailSubject: t('notifications.billingSubscriptionFailed.email.subject', locale),
    emailBody: t('notifications.billingSubscriptionFailed.email.body', locale, {
      subscriptionId,
      reason,
    }),
  };
}

/* ------------------------------------------------------------------ */
/*  Transactional / consent gating                                     */
/* ------------------------------------------------------------------ */

/**
 * Return `true` when `event` is transactional (Requirement 17.2) and
 * `false` when it requires `consents.marketing = true` (Requirement
 * 17.1). All four events handled today are transactional — the
 * function exists so adding a marketing arm is a one-line change to
 * {@link TRANSACTIONAL_KIND}.
 */
function isTransactional(eventType: HandledEventType): boolean {
  return TRANSACTIONAL_KIND[eventType];
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Handle a single inbound event. Pure function over injected ports.
 *
 * Flow:
 *
 *   1. **Atomic dedup claim (Req 17.4).** `tryAcquire(event.id, ttl)`
 *      → short-circuit with `'skipped_duplicate'` before any
 *      downstream I/O. Sprint 11 / Slice 11.1 (critique C2.4)
 *      replaced the historical `hasSeen()`+`markSeen()` pair with
 *      a single atomic call so two concurrent workers can no longer
 *      both see "not seen" and both fire the email. The fail-arm
 *      (any `throw` after the claim is acquired) calls
 *      {@link DedupStore.release} so the queue redelivery loop
 *      stays unblocked.
 *   2. **Ignore untracked event types.** A typed `AthlyaEvent` whose
 *      `type` is not in {@link HANDLED_EVENT_TYPES} returns `'ok'`
 *      with `email: false, push: false` — the bus may still want an
 *      ACK.
 *   3. **Consent gate (Req 17.1 / 17.2).** Transactional events
 *      bypass the marketing flag. Marketing events (none today)
 *      would return `'skipped_no_consent'` here. The claim is
 *      released so a future replay after a consent change refires.
 *   4. **Recipient lookup.** `null` → `'skipped_no_recipient'`. The
 *      claim is released so a future replay after a data restore
 *      still fires.
 *   5. **Render + dispatch.** Pick the locale template, run email +
 *      push in parallel. A leg with no rendered template or no
 *      address / no token is skipped silently and reported as
 *      `false` in the result.
 *   6. **Mark seen.** On success, write the dedup entry with a 24 h
 *      TTL so a bus redelivery during that window is a no-op.
 *
 * The function only throws on unexpected port failures (Redis
 * outage, Resend hard error). Expected business outcomes
 * (skipped_*, ok) are returned as values so the caller can branch
 * on `result.status` without a try/catch.
 */
export async function handleEvent(
  event: AthlyaEvent,
  deps: HandleEventDeps,
): Promise<HandleResult> {
  const { dedup, recipients, email, push, logger } = deps;

  // ---- Step 1: dedup guard --------------------------------------
  //
  // Sprint 11 / Slice 11.1 (critique C2.4) — atomic claim. The
  // `tryAcquire(eventId, ttl)` reply tells us whether we are the
  // first worker to pick this `event.id` up. A `false` reply means
  // a previous worker already wrote the claim row (or the same
  // worker on a queue redelivery), so we short-circuit with
  // `skipped_duplicate` before touching any downstream port.
  //
  // The TTL uses the full {@link DEDUP_TTL_SECONDS} value (24 h),
  // matching the previous `markSeen()` behaviour. We extend
  // claim+commit into a single round-trip; the `release()` call
  // in the `catch` arm and the early-return paths below restore
  // the redelivery semantics the old `hasSeen()`/`markSeen()`
  // pair offered.
  const acquired = await dedup.tryAcquire(event.id, DEDUP_TTL_SECONDS);
  if (!acquired) {
    logger.info('notifications.skipped_duplicate', {
      eventId: event.id,
      type: event.type,
    });
    return { status: 'skipped_duplicate' };
  }

  try {
    // ---- Step 2: ignore untracked event types -----------------
    if (!isHandled(event.type)) {
      logger.info('notifications.ignored_type', {
        eventId: event.id,
        type: event.type,
      });
      // NOT keeping the claim: an operator who later teaches
      // this consumer about the event type should be able to
      // backfill via a replay. Release so the redelivery is
      // not silently swallowed.
      await dedup.release(event.id);
      return { status: 'ok', email: false, push: false };
    }

    // Narrow `event` to the handled arms so `payload.userId` is
    // available below. Every handled event's payload has `userId`.
    const handled = event as
      | ReservationCreatedEvent
      | ReservationReminderEvent
      | ReservationCancelledEvent
      | ReservationPromotedEvent
      | BillingSubscriptionFailedEvent;
    const userId = handled.payload.userId;

    // ---- Step 4: recipient lookup -----------------------------
    //
    // We do the recipient lookup *before* the consent gate
    // because the consent flag lives on the recipient row
    // itself — reading the row is the cheapest way to know
    // whether to send.
    const recipient = await recipients.getRecipient(userId);
    if (recipient === null) {
      logger.warn('notifications.skipped_no_recipient', {
        eventId: event.id,
        type: event.type,
        userId,
      });
      // Release the claim: the replay machinery will retry if
      // the user reappears (e.g. RGPD export restore).
      await dedup.release(event.id);
      return { status: 'skipped_no_recipient' };
    }

    // ---- Step 3 (delayed): consent gate -----------------------
    //
    // Transactional events bypass the marketing flag (Req 17.2).
    // The analytics / thirdParty flags are unused by the
    // notifications module today — they gate other consumers
    // entirely.
    //
    // The built-in `isTransactional` table classifies every
    // handled event type as transactional today. Tests inject
    // `deps.isTransactional` to flip a handled type to
    // marketing without needing a real marketing event in the
    // shared catalog (see `__tests__/consent.test.ts`).
    const isTx =
      deps.isTransactional !== undefined
        ? deps.isTransactional(handled.type)
        : isTransactional(handled.type);
    if (!isTx && !recipient.consents.marketing) {
      logger.info('notifications.skipped_no_consent', {
        eventId: event.id,
        type: event.type,
        userId,
      });
      // Release the claim: if the user updates their consent
      // later and an operator replays the event, it should
      // fire.
      await dedup.release(event.id);
      return { status: 'skipped_no_consent' };
    }

    // ---- Step 5: render, member preferences, dispatch ----------
    //
    // A channel the member turned off for this message is dropped
    // from the rendered template (issue #762); mandatory messages are
    // never affected (`isNotificationEnabled`).
    const rendered = render(handled, recipient.locale);
    const stored =
      deps.preferences === undefined ? null : await deps.preferences.getPreferences(userId);
    const key = PREFERENCE_KEY[handled.type];
    const emailOn = isNotificationEnabled(stored, key, 'email');
    const pushOn = isNotificationEnabled(stored, key, 'push');
    if (!emailOn || !pushOn) {
      logger.info('notifications.skipped_preference', {
        eventId: event.id,
        type: event.type,
        userId,
        email: !emailOn,
        push: !pushOn,
      });
    }
    const message: RenderedMessage = {
      ...(emailOn ? { emailSubject: rendered.emailSubject, emailBody: rendered.emailBody } : {}),
      ...(pushOn
        ? {
            pushTitle: rendered.pushTitle,
            pushBody: rendered.pushBody,
            pushData: rendered.pushData,
          }
        : {}),
    };

    const emailPromise = maybeSendEmail(message, recipient, email);
    const pushPromise = maybeSendPush(message, recipient, push);

    const [emailSent, pushSent] = await Promise.all([emailPromise, pushPromise]);

    // ---- Step 6: keep the claim (success path) ----------------
    //
    // The atomic claim from Step 1 is already persisted with the
    // 24 h TTL — there is nothing more to do here. A bus
    // redelivery within the TTL window will see the claim and
    // short-circuit at Step 1 with `skipped_duplicate`, which
    // is the deduplication contract Req 17.4 asks for.
    logger.info('notifications.ok', {
      eventId: event.id,
      type: handled.type,
      userId,
      email: emailSent,
      push: pushSent,
    });

    return { status: 'ok', email: emailSent, push: pushSent };
  } catch (err) {
    // Sprint 11 / Slice 11.1 (critique C2.4) — release the claim
    // so Cloudflare Queues' at-least-once redelivery semantics
    // can re-process the event. Without this branch, a transient
    // Resend / push failure would silently squash all subsequent
    // retries because the claim row would still answer
    // `tryAcquire() === false` at Step 1 above.
    //
    // `release()` is idempotent (DEL of an absent key is a
    // no-op), so we do not branch on the type of failure.
    try {
      await dedup.release(event.id);
    } catch (releaseErr) {
      // Log but rethrow the ORIGINAL error — the dispatch
      // failure is the operationally-meaningful one.
      logger.warn('notifications.release_failed', {
        eventId: event.id,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Send helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runtime narrowing for the routing table. A plain `.includes` with a
 * readonly tuple does not refine the type in TypeScript 5.9, so the
 * cast is isolated here rather than sprinkled at every call site.
 */
function isHandled(type: AthlyaEvent['type']): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Run the email leg if both the template carries subject+body and the
 * recipient has an address. Return `true` only when the send was
 * actually attempted and the sender resolved.
 */
async function maybeSendEmail(
  message: RenderedMessage,
  recipient: Recipient,
  email: EmailSender,
): Promise<boolean> {
  const { emailSubject, emailBody } = message;
  if (emailSubject === undefined || emailBody === undefined || recipient.email === null) {
    return false;
  }
  await email.send({
    to: recipient.email,
    subject: emailSubject,
    // The adapter is responsible for escaping — this module
    // ships plain text as both `text` and a minimally-wrapped
    // `html`. Resend accepts both and picks per content-type.
    html: `<p>${escapeHtml(emailBody)}</p>`,
    text: emailBody,
  });
  return true;
}

/**
 * Run the push leg if the template carries title+body and the
 * recipient registered at least one device token.
 */
async function maybeSendPush(
  message: RenderedMessage,
  recipient: Recipient,
  push: PushSender,
): Promise<boolean> {
  const { pushTitle, pushBody, pushData } = message;
  if (pushTitle === undefined || pushBody === undefined || recipient.pushTokens.length === 0) {
    return false;
  }
  await push.send({
    tokens: recipient.pushTokens,
    title: pushTitle,
    body: pushBody,
    ...(pushData !== undefined ? { data: pushData } : {}),
  });
  return true;
}

/**
 * Minimal HTML escape for the `<p>…</p>` wrap used above. Covers the
 * five characters OWASP lists as required for a plain text context;
 * full-blown email templating is an adapter-level concern. The
 * templates themselves now come from `@athlya/shared/i18n` under the
 * `notifications.*` namespace (task 19.2 / Req 28.3).
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
