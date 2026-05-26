/**
 * Unit tests for `@athlya/members/cascade`.
 *
 * Covers the two use cases added in task 5.4:
 *
 *   - `handleUserDeleted` — consumer for `auth.user.deleted` that
 *     cascade-deletes reservations, workout sessions, push tokens,
 *     soft-deletes the users row, best-effort purges the R2 avatar,
 *     and schedules the 30-day audit-log anonymisation job
 *     (Requirements 5.2, 5.3, 5.4).
 *   - `anonymizeAuditLog` — the delayed job itself: forwards to the
 *     repo's `anonymizeAuditRows` and is idempotent (a second call
 *     returns the repo's reported row count unchanged).
 *
 * Every port is a hand-rolled `vi.fn()` double so the tests never
 * touch Postgres, Cloudflare R2 or QStash. That matches the style of
 * the sibling test files (`export.test.ts`, `consents.test.ts`,
 * `sessions.test.ts`) and keeps the feedback loop tight.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  ANONYMIZATION_DELAY_DAYS,
  ANONYMIZATION_DELAY_MS,
  anonymizeAuditLog,
  handleUserDeleted,
  type AvatarStore,
  type Clock,
  type DeletionRepo,
  type Logger,
  type Scheduler,
} from '../cascade.js';

import type { AuthUserDeletedEvent } from '@athlya/shared/events';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const EVENT_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad';

/** Frozen wall-clock instant for the cascade step's `now()` call. */
const FROZEN_NOW = Date.parse('2026-02-01T10:00:00.000Z');

/**
 * Build a valid `auth.user.deleted` envelope matching the shape
 * emitted by the Auth service (Requirement 5.1). The `studioId`
 * envelope field is optional at the schema level; we carry it so the
 * shape matches what the production consumer sees.
 */
function buildEvent(): AuthUserDeletedEvent {
  return {
    id: EVENT_ID,
    type: 'auth.user.deleted',
    occurredAt: '2026-02-01T09:59:00.000Z',
    studioId: STUDIO_ID as AuthUserDeletedEvent['studioId'],
    payload: {
      userId: USER_ID as AuthUserDeletedEvent['payload']['userId'],
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hand-rolled {@link DeletionRepo} double. Declared as a helper rather
 * than inlined in each test so the individual cases stay focused on
 * the behaviour under test.
 */
function buildRepo(): {
  repo: DeletionRepo;
  deleteReservationsForUser: Mock<DeletionRepo['deleteReservationsForUser']>;
  deleteWorkoutSessionsForUser: Mock<DeletionRepo['deleteWorkoutSessionsForUser']>;
  deletePushTokensForUser: Mock<DeletionRepo['deletePushTokensForUser']>;
  deleteIdempotencyKeysForUser: Mock<DeletionRepo['deleteIdempotencyKeysForUser']>;
  markUserDeleted: Mock<DeletionRepo['markUserDeleted']>;
  anonymizeAuditRows: Mock<DeletionRepo['anonymizeAuditRows']>;
} {
  const deleteReservationsForUser = vi.fn<DeletionRepo['deleteReservationsForUser']>();
  const deleteWorkoutSessionsForUser = vi.fn<DeletionRepo['deleteWorkoutSessionsForUser']>();
  const deletePushTokensForUser = vi.fn<DeletionRepo['deletePushTokensForUser']>();
  const deleteIdempotencyKeysForUser = vi.fn<DeletionRepo['deleteIdempotencyKeysForUser']>();
  const markUserDeleted = vi.fn<DeletionRepo['markUserDeleted']>();
  const anonymizeAuditRows = vi.fn<DeletionRepo['anonymizeAuditRows']>();

  const repo: DeletionRepo = {
    deleteReservationsForUser,
    deleteWorkoutSessionsForUser,
    deletePushTokensForUser,
    deleteIdempotencyKeysForUser,
    markUserDeleted,
    anonymizeAuditRows,
  };

  return {
    repo,
    deleteReservationsForUser,
    deleteWorkoutSessionsForUser,
    deletePushTokensForUser,
    deleteIdempotencyKeysForUser,
    markUserDeleted,
    anonymizeAuditRows,
  };
}

function buildAvatars(): {
  avatars: AvatarStore;
  deleteAvatar: Mock<AvatarStore['deleteAvatar']>;
} {
  const deleteAvatar = vi.fn<AvatarStore['deleteAvatar']>();
  const avatars: AvatarStore = { deleteAvatar };
  return { avatars, deleteAvatar };
}

function buildScheduler(): {
  scheduler: Scheduler;
  scheduleAnonymization: Mock<Scheduler['scheduleAnonymization']>;
} {
  const scheduleAnonymization = vi.fn<Scheduler['scheduleAnonymization']>();
  const scheduler: Scheduler = { scheduleAnonymization };
  return { scheduler, scheduleAnonymization };
}

/** Clock that always returns the same frozen instant. */
function buildClock(now: number = FROZEN_NOW): Clock {
  return { now: () => now };
}

function buildLogger(): {
  logger: Logger;
  warn: Mock<Logger['warn']>;
  error: Mock<Logger['error']>;
} {
  const warn = vi.fn<Logger['warn']>();
  const error = vi.fn<Logger['error']>();
  const logger: Logger = { warn, error };
  return { logger, warn, error };
}

/* ------------------------------------------------------------------ */
/*  Constants sanity                                                   */
/* ------------------------------------------------------------------ */

describe('cascade constants', () => {
  it('computes the 30-day anonymisation delay in milliseconds (Requirement 5.3)', () => {
    expect(ANONYMIZATION_DELAY_DAYS).toBe(30);
    expect(ANONYMIZATION_DELAY_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------ */
/*  handleUserDeleted — happy path                                     */
/* ------------------------------------------------------------------ */

describe('handleUserDeleted — happy path', () => {
  it('cascade-deletes every table, purges the avatar, marks the user deleted, schedules anonymisation 30 days out, and returns counts', async () => {
    const {
      repo,
      deleteReservationsForUser,
      deleteWorkoutSessionsForUser,
      deletePushTokensForUser,
      deleteIdempotencyKeysForUser,
      markUserDeleted,
    } = buildRepo();
    const { avatars, deleteAvatar } = buildAvatars();
    const { scheduler, scheduleAnonymization } = buildScheduler();
    const { logger, warn, error } = buildLogger();

    deleteReservationsForUser.mockResolvedValueOnce(3);
    deleteWorkoutSessionsForUser.mockResolvedValueOnce(7);
    deletePushTokensForUser.mockResolvedValueOnce(2);
    deleteIdempotencyKeysForUser.mockResolvedValueOnce(1);
    markUserDeleted.mockResolvedValueOnce(undefined);
    deleteAvatar.mockResolvedValueOnce(undefined);
    scheduleAnonymization.mockResolvedValueOnce(undefined);

    const result = await handleUserDeleted(buildEvent(), {
      repo,
      avatars,
      scheduler,
      clock: buildClock(FROZEN_NOW),
      logger,
    });

    // Result — counts match what each repo method reported, and
    // the scheduled timestamp is exactly FROZEN_NOW + 30 days.
    const expectedDueAt = new Date(FROZEN_NOW + ANONYMIZATION_DELAY_MS).toISOString();
    expect(result).toEqual({
      kind: 'ok',
      counts: {
        reservations: 3,
        sessions: 7,
        pushTokens: 2,
        idempotencyKeys: 1,
        auditAnonymized: 0,
      },
      scheduledAnonymizationAt: expectedDueAt,
    });

    // Every deletion repo method is called once with the userId.
    expect(deleteReservationsForUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(deleteWorkoutSessionsForUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(deletePushTokensForUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(deleteIdempotencyKeysForUser).toHaveBeenCalledExactlyOnceWith(USER_ID);

    // markUserDeleted called exactly once with the frozen clock.
    expect(markUserDeleted).toHaveBeenCalledTimes(1);
    const [markArgs0, markArgs1] = markUserDeleted.mock.calls[0]!;
    expect(markArgs0).toBe(USER_ID);
    expect(markArgs1).toBeInstanceOf(Date);
    expect(markArgs1.toISOString()).toBe(new Date(FROZEN_NOW).toISOString());

    // Avatar purge was attempted exactly once.
    expect(deleteAvatar).toHaveBeenCalledExactlyOnceWith(USER_ID);

    // Scheduler called with userId + the absolute dueAt instant.
    expect(scheduleAnonymization).toHaveBeenCalledTimes(1);
    const [scheduleArgs0, scheduleArgs1] = scheduleAnonymization.mock.calls[0]!;
    expect(scheduleArgs0).toBe(USER_ID);
    expect(scheduleArgs1).toBeInstanceOf(Date);
    expect(scheduleArgs1.toISOString()).toBe(expectedDueAt);

    // Nothing logged on the happy path.
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('calls each cascade step in the documented order: reservations → sessions → push tokens → idempotencyKeys → markUserDeleted → avatar → scheduler', async () => {
    const { repo, ...mocks } = buildRepo();
    const { avatars, deleteAvatar } = buildAvatars();
    const { scheduler, scheduleAnonymization } = buildScheduler();

    const order: string[] = [];
    mocks.deleteReservationsForUser.mockImplementationOnce(() => {
      order.push('reservations');
      return Promise.resolve(0);
    });
    mocks.deleteWorkoutSessionsForUser.mockImplementationOnce(() => {
      order.push('sessions');
      return Promise.resolve(0);
    });
    mocks.deletePushTokensForUser.mockImplementationOnce(() => {
      order.push('pushTokens');
      return Promise.resolve(0);
    });
    mocks.deleteIdempotencyKeysForUser.mockImplementationOnce(() => {
      order.push('idempotencyKeys');
      return Promise.resolve(0);
    });
    mocks.markUserDeleted.mockImplementationOnce(() => {
      order.push('markUserDeleted');
      return Promise.resolve();
    });
    deleteAvatar.mockImplementationOnce(() => {
      order.push('avatar');
      return Promise.resolve();
    });
    scheduleAnonymization.mockImplementationOnce(() => {
      order.push('scheduler');
      return Promise.resolve();
    });

    await handleUserDeleted(buildEvent(), {
      repo,
      avatars,
      scheduler,
      clock: buildClock(),
    });

    expect(order).toEqual([
      'reservations',
      'sessions',
      'pushTokens',
      'idempotencyKeys',
      'markUserDeleted',
      'avatar',
      'scheduler',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  handleUserDeleted — avatar purge failure is best-effort             */
/* ------------------------------------------------------------------ */

describe('handleUserDeleted — avatar purge failure', () => {
  it('still deletes SQL rows, marks the user, schedules anonymisation, and logs a warning when R2 throws', async () => {
    const {
      repo,
      deleteReservationsForUser,
      deleteWorkoutSessionsForUser,
      deletePushTokensForUser,
      deleteIdempotencyKeysForUser,
      markUserDeleted,
    } = buildRepo();
    const { avatars, deleteAvatar } = buildAvatars();
    const { scheduler, scheduleAnonymization } = buildScheduler();
    const { logger, warn, error } = buildLogger();

    deleteReservationsForUser.mockResolvedValueOnce(1);
    deleteWorkoutSessionsForUser.mockResolvedValueOnce(2);
    deletePushTokensForUser.mockResolvedValueOnce(0);
    deleteIdempotencyKeysForUser.mockResolvedValueOnce(0);
    markUserDeleted.mockResolvedValueOnce(undefined);
    deleteAvatar.mockRejectedValueOnce(new Error('R2 unreachable'));
    scheduleAnonymization.mockResolvedValueOnce(undefined);

    const result = await handleUserDeleted(buildEvent(), {
      repo,
      avatars,
      scheduler,
      clock: buildClock(FROZEN_NOW),
      logger,
    });

    // Cascade completed successfully in spite of the R2 failure.
    expect(result.kind).toBe('ok');
    expect(result.counts).toEqual({
      reservations: 1,
      sessions: 2,
      pushTokens: 0,
      idempotencyKeys: 0,
      auditAnonymized: 0,
    });

    // SQL cascade ran end-to-end.
    expect(deleteReservationsForUser).toHaveBeenCalledTimes(1);
    expect(deleteWorkoutSessionsForUser).toHaveBeenCalledTimes(1);
    expect(deletePushTokensForUser).toHaveBeenCalledTimes(1);
    expect(markUserDeleted).toHaveBeenCalledTimes(1);

    // Scheduler was still invoked — losing it would miss the
    // legal 30-day retention deadline (Requirement 5.3).
    expect(scheduleAnonymization).toHaveBeenCalledTimes(1);

    // The R2 error is surfaced as a warn, not an error — the
    // user-facing compliance invariant is satisfied by the SQL
    // deletions + scheduler publish.
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnMsg, warnExtra] = warn.mock.calls[0]!;
    expect(warnMsg).toMatch(/avatar/i);
    expect(warnExtra).toMatchObject({
      userId: USER_ID,
      eventId: EVENT_ID,
      error: { name: 'Error', message: 'R2 unreachable' },
    });
    expect(error).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  handleUserDeleted — scheduler failure rethrows                     */
/* ------------------------------------------------------------------ */

describe('handleUserDeleted — scheduler failure', () => {
  it('rethrows when scheduleAnonymization fails so the event bus redrives the cascade', async () => {
    const { repo, ...mocks } = buildRepo();
    const { avatars, deleteAvatar } = buildAvatars();
    const { scheduler, scheduleAnonymization } = buildScheduler();

    mocks.deleteReservationsForUser.mockResolvedValueOnce(0);
    mocks.deleteWorkoutSessionsForUser.mockResolvedValueOnce(0);
    mocks.deletePushTokensForUser.mockResolvedValueOnce(0);
    mocks.deleteIdempotencyKeysForUser.mockResolvedValueOnce(0);
    mocks.markUserDeleted.mockResolvedValueOnce(undefined);
    deleteAvatar.mockResolvedValueOnce(undefined);
    scheduleAnonymization.mockRejectedValueOnce(new Error('QStash unreachable'));

    const err = await handleUserDeleted(buildEvent(), {
      repo,
      avatars,
      scheduler,
      clock: buildClock(FROZEN_NOW),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('QStash unreachable');

    // Every prior step still ran — the cascade is retryable,
    // and on redelivery the deletions are no-ops (idempotent).
    expect(mocks.deleteReservationsForUser).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkoutSessionsForUser).toHaveBeenCalledTimes(1);
    expect(mocks.deletePushTokensForUser).toHaveBeenCalledTimes(1);
    expect(mocks.deleteIdempotencyKeysForUser).toHaveBeenCalledTimes(1);
    expect(mocks.markUserDeleted).toHaveBeenCalledTimes(1);
    expect(deleteAvatar).toHaveBeenCalledTimes(1);
    expect(scheduleAnonymization).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  handleUserDeleted — markUserDeleted invariant                      */
/* ------------------------------------------------------------------ */

describe('handleUserDeleted — markUserDeleted', () => {
  it('is called exactly once even if the repo returns zero deletions across every table', async () => {
    const { repo, ...mocks } = buildRepo();
    const { avatars, deleteAvatar } = buildAvatars();
    const { scheduler, scheduleAnonymization } = buildScheduler();

    mocks.deleteReservationsForUser.mockResolvedValueOnce(0);
    mocks.deleteWorkoutSessionsForUser.mockResolvedValueOnce(0);
    mocks.deletePushTokensForUser.mockResolvedValueOnce(0);
    mocks.deleteIdempotencyKeysForUser.mockResolvedValueOnce(0);
    mocks.markUserDeleted.mockResolvedValueOnce(undefined);
    deleteAvatar.mockResolvedValueOnce(undefined);
    scheduleAnonymization.mockResolvedValueOnce(undefined);

    await handleUserDeleted(buildEvent(), {
      repo,
      avatars,
      scheduler,
      clock: buildClock(FROZEN_NOW),
    });

    expect(mocks.markUserDeleted).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  anonymizeAuditLog                                                  */
/* ------------------------------------------------------------------ */

describe('anonymizeAuditLog', () => {
  it('forwards userId to the repo and returns the reported row count', async () => {
    const anonymizeAuditRows = vi.fn<DeletionRepo['anonymizeAuditRows']>();
    anonymizeAuditRows.mockResolvedValueOnce(42);

    const result = await anonymizeAuditLog(USER_ID, {
      repo: { anonymizeAuditRows },
    });

    expect(result).toEqual({
      kind: 'ok',
      userId: USER_ID,
      anonymizedRows: 42,
    });
    expect(anonymizeAuditRows).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it('is idempotent: a second invocation simply returns whatever the repo reports (typically 0)', async () => {
    const anonymizeAuditRows = vi.fn<DeletionRepo['anonymizeAuditRows']>();
    // First call anonymises 17 rows; second call finds zero
    // remaining rows matching actor_id = userId.
    anonymizeAuditRows.mockResolvedValueOnce(17);
    anonymizeAuditRows.mockResolvedValueOnce(0);

    const first = await anonymizeAuditLog(USER_ID, {
      repo: { anonymizeAuditRows },
    });
    const second = await anonymizeAuditLog(USER_ID, {
      repo: { anonymizeAuditRows },
    });

    expect(first.anonymizedRows).toBe(17);
    expect(second.anonymizedRows).toBe(0);

    // Both calls forwarded the same userId — the repo's
    // SQL-level idempotency guarantee is what drives the zero
    // count on the second pass.
    expect(anonymizeAuditRows).toHaveBeenCalledTimes(2);
    expect(anonymizeAuditRows.mock.calls[0]![0]).toBe(USER_ID);
    expect(anonymizeAuditRows.mock.calls[1]![0]).toBe(USER_ID);
  });

  it('propagates repo failures to the caller', async () => {
    const anonymizeAuditRows = vi.fn<DeletionRepo['anonymizeAuditRows']>();
    anonymizeAuditRows.mockRejectedValueOnce(new Error('db down'));

    const err = await anonymizeAuditLog(USER_ID, {
      repo: { anonymizeAuditRows },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('db down');
  });
});
