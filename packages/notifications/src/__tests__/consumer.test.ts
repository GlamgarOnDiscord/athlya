/**
 * Unit tests for `@athlya/notifications/consumer`.
 *
 * Covers the four transactional events the consumer handles plus the
 * three skip paths mandated by Requirement 17:
 *
 *   - `reservation.created`             → email + push fired, dedup
 *                                         entry written (Req 17.1/2).
 *   - `reservation.reminder`            → push only (template carries
 *                                         no email subject/body).
 *   - `reservation.cancelled`           → email + push fired.
 *   - `billing.subscription.failed`     → email only (no push).
 *   - Dedup: a second call with the same `event.id` returns
 *     `skipped_duplicate` and never calls a sender (Req 17.4).
 *   - Recipient repo returns `null` → `skipped_no_recipient`, no
 *     sends, no dedup write (so a replay after restore still fires).
 *   - Transactional events ship even when `consents.marketing` is
 *     `false` (Req 17.2).
 *
 * Every dependency is a hand-rolled `vi.fn()` double — no Redis, no
 * Resend, no Expo. Matches the style used in
 * `packages/reservations/src/__tests__/checkin.test.ts`.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  DEDUP_TTL_SECONDS,
  handleEvent,
  type DedupStore,
  type EmailSender,
  type HandleEventDeps,
  type Logger,
  type PushSender,
  type Recipient,
  type RecipientRepo,
} from '../consumer.js';

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
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const EVENT_ID = 'a1b2c3d4-5678-4abc-89ef-1234567890ab';
const STUDIO_ID = 'b2c3d4e5-6789-4bcd-9aef-234567890abc';
const USER_ID = 'c3d4e5f6-789a-4cde-abef-34567890abcd';
const CLASS_ID = 'd4e5f6a7-89ab-4def-bcef-4567890abcde';
const RESERVATION_ID = 'e5f6a7b8-9abc-4ef0-bfef-567890abcdef';
const SUBSCRIPTION_ID = 'sub_ABC123';

const NOW_ISO = '2025-01-15T10:00:00.000Z';
const STARTS_AT_ISO = '2025-01-15T11:00:00.000Z';

/** Default consents. Marketing is `false` so we exercise the
 *  "transactional bypasses marketing" invariant in every test. */
const CONSENTS_MARKETING_OFF: Consents = {
  marketing: false,
  analytics: false,
  thirdParty: false,
  version: '2025-01',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

/**
 * Canonical recipient fixture. Tests override individual fields via
 * the spread in {@link buildRecipient}.
 */
const BASE_RECIPIENT: Recipient = {
  userId: USER_ID,
  email: 'member@example.com',
  pushTokens: ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'],
  consents: CONSENTS_MARKETING_OFF,
  locale: 'fr',
};

function buildRecipient(overrides: Partial<Recipient> = {}): Recipient {
  return { ...BASE_RECIPIENT, ...overrides };
}

/* ------------------------------------------------------------------ */
/*  Event builders                                                     */
/* ------------------------------------------------------------------ */

function createdEvent(overrides: Partial<ReservationCreatedEvent> = {}): ReservationCreatedEvent {
  return {
    id: EVENT_ID,
    type: 'reservation.created',
    occurredAt: NOW_ISO,
    studioId: STUDIO_ID,
    payload: {
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
    },
    ...overrides,
  } as ReservationCreatedEvent;
}

function reminderEvent(
  overrides: Partial<ReservationReminderEvent> = {},
): ReservationReminderEvent {
  return {
    id: EVENT_ID,
    type: 'reservation.reminder',
    occurredAt: NOW_ISO,
    studioId: STUDIO_ID,
    payload: {
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
      startsAt: STARTS_AT_ISO,
    },
    ...overrides,
  } as ReservationReminderEvent;
}

function cancelledEvent(
  overrides: Partial<ReservationCancelledEvent> = {},
): ReservationCancelledEvent {
  return {
    id: EVENT_ID,
    type: 'reservation.cancelled',
    occurredAt: NOW_ISO,
    studioId: STUDIO_ID,
    payload: {
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
    },
    ...overrides,
  } as ReservationCancelledEvent;
}

function promotedEvent(
  overrides: Partial<ReservationPromotedEvent> = {},
): ReservationPromotedEvent {
  return {
    id: EVENT_ID,
    type: 'reservation.promoted',
    occurredAt: NOW_ISO,
    studioId: STUDIO_ID,
    payload: {
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      userId: USER_ID,
    },
    ...overrides,
  } as ReservationPromotedEvent;
}

function billingFailedEvent(
  overrides: Partial<BillingSubscriptionFailedEvent> = {},
): BillingSubscriptionFailedEvent {
  return {
    id: EVENT_ID,
    type: 'billing.subscription.failed',
    occurredAt: NOW_ISO,
    studioId: STUDIO_ID,
    payload: {
      userId: USER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      reason: 'card_declined',
    },
    ...overrides,
  } as BillingSubscriptionFailedEvent;
}

/* ------------------------------------------------------------------ */
/*  Deps builder                                                       */
/* ------------------------------------------------------------------ */

interface DepsHandles {
  readonly tryAcquire: Mock<DedupStore['tryAcquire']>;
  readonly release: Mock<DedupStore['release']>;
  readonly getRecipient: Mock<RecipientRepo['getRecipient']>;
  readonly sendEmail: Mock<EmailSender['send']>;
  readonly sendPush: Mock<PushSender['send']>;
  readonly logger: Logger;
  readonly deps: HandleEventDeps;
}

function buildDeps(recipient: Recipient | null = BASE_RECIPIENT): DepsHandles {
  // Sprint 11 / Slice 11.1 (critique C2.4) — atomic dedup. Default:
  // `tryAcquire` returns true on first call ("we are the first
  // worker"). Tests that simulate a redelivery flip the mock to
  // return false. `release` is a no-op stub by default; assertions
  // pin its call count where it matters.
  const tryAcquire = vi.fn<DedupStore['tryAcquire']>().mockResolvedValue(true);
  const release = vi.fn<DedupStore['release']>().mockResolvedValue();
  const getRecipient = vi.fn<RecipientRepo['getRecipient']>().mockResolvedValue(recipient);
  const sendEmail = vi.fn<EmailSender['send']>().mockResolvedValue();
  const sendPush = vi.fn<PushSender['send']>().mockResolvedValue();

  // Logger stubs are silent so vitest output stays focused on
  // failures; unit tests here don't assert on log content, only on
  // sender behaviour.
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    tryAcquire,
    release,
    getRecipient,
    sendEmail,
    sendPush,
    logger,
    deps: {
      dedup: { tryAcquire, release },
      recipients: { getRecipient },
      email: { send: sendEmail },
      push: { send: sendPush },
      logger,
    },
  };
}

/* ================================================================== */
/*  reservation.created — email + push + markSeen                      */
/* ================================================================== */

describe('handleEvent — reservation.created', () => {
  it('sends email + push and marks the event seen', async () => {
    const { tryAcquire, release, sendEmail, sendPush, deps } = buildDeps();

    const result = await handleEvent(createdEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: true });

    // Sprint 11 / Slice 11.1 (critique C2.4) — atomic claim.
    // `tryAcquire` is called exactly once with the event id and
    // the 24 h TTL; success path keeps the claim (no `release`).
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(release).not.toHaveBeenCalled();

    // Email goes to the member's address with a French subject
    // because the recipient's locale is `fr`.
    expect(sendEmail).toHaveBeenCalledOnce();
    const emailCall = sendEmail.mock.calls[0]?.[0];
    expect(emailCall?.to).toBe('member@example.com');
    expect(emailCall?.subject).toBe('Réservation confirmée');
    expect(emailCall?.text).toContain(RESERVATION_ID);

    // Push fans out to every registered device token.
    expect(sendPush).toHaveBeenCalledOnce();
    const pushCall = sendPush.mock.calls[0]?.[0];
    expect(pushCall?.tokens).toEqual(BASE_RECIPIENT.pushTokens);
    expect(pushCall?.data).toMatchObject({
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      type: 'reservation.created',
    });
  });

  it('ships transactionally even when consents.marketing is false', async () => {
    // The fixture already has marketing=false; the happy-path
    // test above already covers this implicitly. Assert
    // explicitly here so the invariant shows up in the test
    // report as a dedicated line.
    const { sendEmail, sendPush, deps } = buildDeps(
      buildRecipient({
        consents: { ...CONSENTS_MARKETING_OFF, marketing: false },
      }),
    );

    const result = await handleEvent(createdEvent(), deps);

    expect(result.status).toBe('ok');
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
  });

  it('uses the English template when the recipient locale is en', async () => {
    const { sendEmail, deps } = buildDeps(buildRecipient({ locale: 'en' }));

    await handleEvent(createdEvent(), deps);

    expect(sendEmail.mock.calls[0]?.[0].subject).toBe('Reservation confirmed');
  });
});

/* ================================================================== */
/*  reservation.reminder — push only                                   */
/* ================================================================== */

describe('handleEvent — reservation.reminder', () => {
  it('sends push only and skips the email leg', async () => {
    const { sendEmail, sendPush, tryAcquire, release, deps } = buildDeps();

    const result = await handleEvent(reminderEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: false, push: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).toHaveBeenCalledOnce();
    expect(sendPush.mock.calls[0]?.[0].title).toBe('Rappel de cours');
    // Push payload carries the class metadata for deep-linking.
    expect(sendPush.mock.calls[0]?.[0].data).toMatchObject({
      startsAt: STARTS_AT_ISO,
      type: 'reservation.reminder',
    });
    // Sprint 11 / Slice 11.1 (critique C2.4) — single atomic claim,
    // no release on the success path.
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(release).not.toHaveBeenCalled();
  });

  it('returns push=false when the recipient has no registered tokens', async () => {
    // Edge case: the device registration hasn't completed. The
    // consumer still succeeds (so the bus acks the message) but
    // reports no push was sent.
    const { sendPush, deps } = buildDeps(buildRecipient({ pushTokens: [] }));

    const result = await handleEvent(reminderEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: false, push: false });
    expect(sendPush).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  reservation.cancelled — email + push                               */
/* ================================================================== */

describe('handleEvent — reservation.cancelled', () => {
  it('sends email + push', async () => {
    const { sendEmail, sendPush, deps } = buildDeps();

    const result = await handleEvent(cancelledEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: true });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe('Réservation annulée');
    expect(sendPush).toHaveBeenCalledOnce();
    expect(sendPush.mock.calls[0]?.[0].title).toBe('Réservation annulée');
  });
});

/* ================================================================== */
/*  reservation.promoted — email + push, transactional                 */
/* ================================================================== */

describe('handleEvent — reservation.promoted', () => {
  it('sends email + push with the FR "you\'re in" template', async () => {
    const { sendEmail, sendPush, tryAcquire, release, deps } = buildDeps();

    const result = await handleEvent(promotedEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: true });

    // Email: FR subject and body must reference the reservation
    // id so the member can correlate with their booking history.
    expect(sendEmail).toHaveBeenCalledOnce();
    const emailCall = sendEmail.mock.calls[0]?.[0];
    expect(emailCall?.subject).toBe('Bonne nouvelle, vous êtes inscrit !');
    expect(emailCall?.text).toContain(RESERVATION_ID);

    // Push: FR title matches the spec exactly — the body / title
    // pair is what appears on the lock screen.
    expect(sendPush).toHaveBeenCalledOnce();
    const pushCall = sendPush.mock.calls[0]?.[0];
    expect(pushCall?.title).toBe('Vous êtes inscrit !');
    expect(pushCall?.body).toBe('Votre place au cours est confirmée.');
    // Deep-link metadata carries class + reservation ids so the
    // mobile app can route the tap to the correct booking detail.
    expect(pushCall?.data).toMatchObject({
      reservationId: RESERVATION_ID,
      classId: CLASS_ID,
      type: 'reservation.promoted',
    });

    // Sprint 11 / Slice 11.1 (critique C2.4) — atomic claim like
    // every other handled event.
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(release).not.toHaveBeenCalled();
  });

  it('uses the English template when the recipient locale is en', async () => {
    const { sendEmail, sendPush, deps } = buildDeps(buildRecipient({ locale: 'en' }));

    await handleEvent(promotedEvent(), deps);

    expect(sendEmail.mock.calls[0]?.[0].subject).toBe("You're in!");
    expect(sendPush.mock.calls[0]?.[0].title).toBe("You're in!");
    expect(sendPush.mock.calls[0]?.[0].body).toBe('Your class spot is confirmed.');
  });

  it('ships transactionally even when consents.marketing is false', async () => {
    // Promotion is a direct answer to a member's pending
    // waitlist — withholding it would break the booking flow, so
    // the consent.marketing flag is intentionally ignored (Req
    // 17.2, mirrors `reservation.created`).
    const { sendEmail, sendPush, deps } = buildDeps(
      buildRecipient({
        consents: { ...CONSENTS_MARKETING_OFF, marketing: false },
      }),
    );

    const result = await handleEvent(promotedEvent(), deps);

    expect(result.status).toBe('ok');
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
  });
});

/* ================================================================== */
/*  billing.subscription.failed — email only                           */
/* ================================================================== */

describe('handleEvent — billing.subscription.failed', () => {
  it('sends email only and skips the push leg', async () => {
    const { sendEmail, sendPush, deps } = buildDeps();

    const result = await handleEvent(billingFailedEvent(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: false });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe('Échec du paiement');
    expect(sendEmail.mock.calls[0]?.[0].text).toContain(SUBSCRIPTION_ID);
    expect(sendPush).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  Dedup — second call with the same event.id                         */
/* ================================================================== */

describe('handleEvent — dedup', () => {
  it('returns skipped_duplicate and never calls a sender on second call', async () => {
    const { tryAcquire, release, getRecipient, sendEmail, sendPush, deps } = buildDeps();

    // First call succeeds and persists the atomic claim.
    await handleEvent(createdEvent(), deps);
    expect(tryAcquire).toHaveBeenCalledOnce();

    // Sprint 11 / Slice 11.1 (critique C2.4) — flip the atomic
    // claim store to "already claimed" to simulate Redis
    // persistence, then call again with the same event id.
    tryAcquire.mockResolvedValueOnce(false);
    sendEmail.mockClear();
    sendPush.mockClear();
    getRecipient.mockClear();
    release.mockClear();
    tryAcquire.mockClear();

    const second = await handleEvent(createdEvent(), deps);

    expect(second).toEqual({ status: 'skipped_duplicate' });
    expect(tryAcquire).toHaveBeenCalledOnce();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    // Critical: a duplicate must not re-read the recipient — the
    // whole point of the dedup guard is to short-circuit I/O.
    expect(getRecipient).not.toHaveBeenCalled();
    // And we must not release the claim — the original 24 h TTL
    // continues to govern.
    expect(release).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  Unknown recipient                                                  */
/* ================================================================== */

describe('handleEvent — unknown recipient', () => {
  it('returns skipped_no_recipient and never sends or marks seen', async () => {
    const { sendEmail, sendPush, release, deps } = buildDeps(null);

    const result = await handleEvent(createdEvent(), deps);

    expect(result).toEqual({ status: 'skipped_no_recipient' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    // Sprint 11 / Slice 11.1 (critique C2.4) — release the claim
    // so a replay after an RGPD export restore still fires the
    // notification.
    expect(release).toHaveBeenCalledExactlyOnceWith(EVENT_ID);
  });

  it('propagates skipped_no_recipient for every handled event type', async () => {
    // Table-driven sanity check. A regression in the narrowing
    // logic would show up here first.
    const events: readonly AthlyaEvent[] = [
      createdEvent(),
      reminderEvent(),
      cancelledEvent(),
      promotedEvent(),
      billingFailedEvent(),
    ];

    for (const event of events) {
      const { sendEmail, sendPush, release, deps } = buildDeps(null);
      const result = await handleEvent(event, deps);
      expect(result.status).toBe('skipped_no_recipient');
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendPush).not.toHaveBeenCalled();
      // Release for every event type — the redelivery
      // semantics must not depend on the event shape.
      expect(release).toHaveBeenCalledExactlyOnceWith(EVENT_ID);
    }
  });
});

/* ================================================================== */
/*  Member preferences (issue #762)                                    */
/* ================================================================== */

describe('handleEvent: member preferences', () => {
  it('drops the e-mail the member turned off and keeps the push', async () => {
    const { sendEmail, sendPush, deps } = buildDeps();
    const getPreferences = vi.fn().mockResolvedValue({ reservationCreated: { email: false } });

    const result = await handleEvent(createdEvent(), { ...deps, preferences: { getPreferences } });

    expect(getPreferences).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({ status: 'ok', email: false, push: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).toHaveBeenCalledOnce();
  });

  it('drops the push the member turned off and keeps the e-mail', async () => {
    const { sendEmail, sendPush, deps } = buildDeps();
    const getPreferences = vi.fn().mockResolvedValue({ reservationCancelled: { push: false } });

    const result = await handleEvent(cancelledEvent(), {
      ...deps,
      preferences: { getPreferences },
    });

    expect(result).toEqual({ status: 'ok', email: true, push: false });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('keeps the claim when every channel is off, so a redelivery stays silent', async () => {
    const { release, sendPush, deps } = buildDeps();
    const getPreferences = vi.fn().mockResolvedValue({ reservationReminder: { push: false } });

    const result = await handleEvent(reminderEvent(), { ...deps, preferences: { getPreferences } });

    expect(result).toEqual({ status: 'ok', email: false, push: false });
    expect(sendPush).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('always sends the mandatory payment failure e-mail', async () => {
    const { sendEmail, deps } = buildDeps();
    const getPreferences = vi
      .fn()
      .mockResolvedValue({ billingSubscriptionFailed: { email: false } });

    const result = await handleEvent(billingFailedEvent(), {
      ...deps,
      preferences: { getPreferences },
    });

    expect(result).toEqual({ status: 'ok', email: true, push: false });
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});
