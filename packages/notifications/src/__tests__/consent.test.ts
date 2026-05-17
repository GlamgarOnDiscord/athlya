/**
 * Unit tests for `@athlya/notifications/consumer` — consent gating
 * and dedup (task 9.7).
 *
 * The existing suite in `consumer.test.ts` already covers the four
 * transactional events end-to-end (email + push + dedup write) and
 * the "transactional bypasses marketing" happy path. This file
 * focuses strictly on the three invariants called out in task 9.7:
 *
 *   - **Req 17.1** — a marketing message MUST be skipped when the
 *     recipient has not consented to marketing, and MUST be sent
 *     when they have.
 *   - **Req 17.2** — a transactional message MUST be sent regardless
 *     of the marketing consent flag.
 *   - **Req 17.4** — a second call with the same `event.id` MUST be
 *     deduplicated: no senders, no second `markSeen`.
 *
 * ### Why the `isTransactional` override
 *
 * All four event types the consumer handles today are classified as
 * transactional by the built-in lookup table. There is no marketing
 * event type in `@athlya/shared/events` yet, so to exercise the
 * consent-gated branch we inject `deps.isTransactional` that flips
 * the classification for the test. Production callers never pass
 * this port — it defaults to the internal table — so the override
 * is testing infrastructure only.
 *
 * Every dependency is a `vi.fn()` double. No Redis, no Resend, no
 * Expo. Matches the style of `consumer.test.ts`.
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

import type { ReservationCreatedEvent } from '@athlya/shared/events';
import type { Consents } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const EVENT_ID = 'f1e2d3c4-5678-4abc-89ef-abcdef012345';
const STUDIO_ID = 'e2d3c4b5-6789-4bcd-9aef-bcdef0123456';
const USER_ID = 'd3c4b5a6-789a-4cde-abef-cdef01234567';
const CLASS_ID = 'c4b5a697-89ab-4def-bcef-def012345678';
const RESERVATION_ID = 'b5a69788-9abc-4ef0-bfef-ef0123456789';

const NOW_ISO = '2025-02-10T09:00:00.000Z';

const CONSENTS_MARKETING_OFF: Consents = {
  marketing: false,
  analytics: false,
  thirdParty: false,
  version: '2025-01',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const CONSENTS_MARKETING_ON: Consents = {
  ...CONSENTS_MARKETING_OFF,
  marketing: true,
  updatedAt: '2025-02-01T00:00:00.000Z',
};

const BASE_RECIPIENT: Recipient = {
  userId: USER_ID,
  email: 'member@example.com',
  pushTokens: ['ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'],
  consents: CONSENTS_MARKETING_OFF,
  locale: 'fr',
};

function buildRecipient(overrides: Partial<Recipient> = {}): Recipient {
  return { ...BASE_RECIPIENT, ...overrides };
}

/**
 * A single event shape is enough for consent tests — `reservation.created`
 * renders both an email and a push leg, so the "no send" assertions
 * cover both transports in one call.
 */
function event(overrides: Partial<ReservationCreatedEvent> = {}): ReservationCreatedEvent {
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

interface BuildDepsOptions {
  readonly recipient?: Recipient | null;
  /**
   * Override for the built-in transactional classifier. Returning
   * `false` routes the event through the consent gate (Req 17.1);
   * returning `true` bypasses it (Req 17.2); omitting it falls back
   * to the internal table, which marks every handled type as
   * transactional today.
   */
  readonly isTransactional?: (type: string) => boolean;
}

function buildDeps({
  recipient = BASE_RECIPIENT,
  isTransactional,
}: BuildDepsOptions = {}): DepsHandles {
  // Sprint 11 / Slice 11.1 (critique C2.4) — atomic dedup port.
  const tryAcquire = vi.fn<DedupStore['tryAcquire']>().mockResolvedValue(true);
  const release = vi.fn<DedupStore['release']>().mockResolvedValue();
  const getRecipient = vi.fn<RecipientRepo['getRecipient']>().mockResolvedValue(recipient);
  const sendEmail = vi.fn<EmailSender['send']>().mockResolvedValue();
  const sendPush = vi.fn<PushSender['send']>().mockResolvedValue();

  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const deps: HandleEventDeps = {
    dedup: { tryAcquire, release },
    recipients: { getRecipient },
    email: { send: sendEmail },
    push: { send: sendPush },
    logger,
    ...(isTransactional !== undefined ? { isTransactional } : {}),
  };

  return {
    tryAcquire,
    release,
    getRecipient,
    sendEmail,
    sendPush,
    logger,
    deps,
  };
}

/* ================================================================== */
/*  Req 17.1 — marketing consent is required for marketing messages    */
/* ================================================================== */

describe('handleEvent — marketing consent gating', () => {
  /**
   * **Validates: Requirements 17.1**
   *
   * When the event is reclassified as marketing (via the test
   * override) and the recipient has `consents.marketing = false`,
   * the consumer MUST return `skipped_no_consent` and MUST NOT call
   * any sender. Critically, it MUST NOT write the dedup entry — a
   * future consent update followed by an operator replay should
   * still deliver.
   */
  it('skips marketing messages when consents.marketing is false', async () => {
    const { sendEmail, sendPush, release, deps } = buildDeps({
      recipient: buildRecipient({
        consents: CONSENTS_MARKETING_OFF,
      }),
      // Flip the handled event type to marketing for this call.
      isTransactional: () => false,
    });

    const result = await handleEvent(event(), deps);

    expect(result).toEqual({ status: 'skipped_no_consent' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    // Sprint 11 / Slice 11.1 (critique C2.4) — release the claim:
    // an operator replay after a consent update must re-fire.
    expect(release).toHaveBeenCalledExactlyOnceWith(EVENT_ID);
  });

  /**
   * **Validates: Requirements 17.1**
   *
   * Same marketing classification, but the recipient has granted
   * marketing consent. The message MUST be delivered normally and
   * the dedup entry MUST be written.
   */
  it('sends marketing messages when consents.marketing is true', async () => {
    const { sendEmail, sendPush, tryAcquire, release, deps } = buildDeps({
      recipient: buildRecipient({
        consents: CONSENTS_MARKETING_ON,
      }),
      isTransactional: () => false,
    });

    const result = await handleEvent(event(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: true });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
    // Sprint 11 / Slice 11.1 (critique C2.4) — atomic claim
    // persisted on success; release stays untouched.
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(release).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  Req 17.2 — transactional messages bypass the marketing flag        */
/* ================================================================== */

describe('handleEvent — transactional bypass', () => {
  /**
   * **Validates: Requirements 17.2**
   *
   * Transactional messages are reservation / check-in / billing
   * notices that the member needs to receive regardless of their
   * marketing preferences. With `consents.marketing = false` and
   * the classifier returning `true`, the consumer MUST deliver.
   */
  it('sends transactional messages even when consents.marketing is false', async () => {
    const { sendEmail, sendPush, tryAcquire, release, deps } = buildDeps({
      recipient: buildRecipient({
        consents: CONSENTS_MARKETING_OFF,
      }),
      // Explicit transactional classification mirrors the
      // production default for every handled event type today.
      isTransactional: () => true,
    });

    const result = await handleEvent(event(), deps);

    expect(result).toEqual({ status: 'ok', email: true, push: true });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(release).not.toHaveBeenCalled();
  });

  /**
   * **Validates: Requirements 17.2**
   *
   * Same as above but relying on the built-in classifier (no
   * override). Every event type in `HANDLED_EVENT_TYPES` is
   * classified as transactional out of the box, so the default
   * wiring MUST also bypass the marketing flag.
   */
  it('uses the built-in classifier to bypass consent for reservation.created', async () => {
    const { sendEmail, sendPush, deps } = buildDeps({
      recipient: buildRecipient({
        consents: CONSENTS_MARKETING_OFF,
      }),
      // No isTransactional override → built-in lookup fires.
    });

    const result = await handleEvent(event(), deps);

    expect(result.status).toBe('ok');
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
  });
});

/* ================================================================== */
/*  Req 17.4 — dedup on event.id                                       */
/* ================================================================== */

describe('handleEvent — dedup on event.id', () => {
  /**
   * **Validates: Requirements 17.4**
   *
   * A replayed event with the same `event.id` MUST be a no-op:
   *
   *   - the consumer returns `skipped_duplicate`,
   *   - no sender is invoked,
   *   - the recipient repo is not re-queried (the whole point of
   *     the guard is to short-circuit I/O), and
   *   - `release` is not called a second time so the original
   *     24 h TTL governs.
   *
   * The simulation persists the atomic claim on the first call
   * (default `tryAcquire` mock returns `true`) and flips it to
   * `false` on the second to model Redis persistence across calls.
   */
  it('does not send a replayed event twice', async () => {
    const { tryAcquire, release, getRecipient, sendEmail, sendPush, deps } = buildDeps();

    // First delivery: goes through normally, persists the claim.
    const first = await handleEvent(event(), deps);
    expect(first).toEqual({ status: 'ok', email: true, push: true });
    expect(tryAcquire).toHaveBeenCalledExactlyOnceWith(EVENT_ID, DEDUP_TTL_SECONDS);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();

    // Flip the store to "already claimed" and reset call
    // counters so the assertions below only reflect the second
    // call.
    tryAcquire.mockResolvedValueOnce(false);
    sendEmail.mockClear();
    sendPush.mockClear();
    getRecipient.mockClear();
    release.mockClear();

    const second = await handleEvent(event(), deps);

    expect(second).toEqual({ status: 'skipped_duplicate' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    expect(getRecipient).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
