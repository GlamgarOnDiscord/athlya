/**
 * Unit tests for `@athlya/members/consents`.
 *
 * Covers the single use case added in task 5.2:
 *   - `updateConsents` — Requirements 3.3 (versioned record with
 *     server-stamped `version` and `updatedAt`) and 22.1 (append-only
 *     audit log entry `user.consents.updated` with previous + new
 *     versions).
 *
 * The repo and audit writer are hand-rolled `vi.fn()` doubles so the
 * tests never touch Drizzle or a real Postgres — they exercise the
 * service layer in pure isolation, matching the style of
 * `./service.test.ts` and `./sessions.test.ts`.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CURRENT_CGU_VERSION,
  updateConsents,
  type AuditLogWriter,
  type ConsentsRepo,
  type ConsentsServiceDeps,
} from '../consents.js';
import { MembersError } from '../service.js';

import type { Consents } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';

/** An existing consents row with an older CGU version. */
const PREVIOUS_CONSENTS: Consents = {
  marketing: false,
  analytics: false,
  thirdParty: false,
  version: '2025-06',
  updatedAt: '2025-06-15T10:00:00.000Z',
};

/** The valid input payload clients send on the wire. */
const VALID_INPUT = {
  marketing: true,
  analytics: true,
  thirdParty: false,
} as const;

/**
 * Build a fresh `ConsentsServiceDeps` with `vi.fn()` doubles and a
 * deterministic clock at `2026-01-15T12:00:00.000Z`.
 */
function buildDeps(overrides?: { now?: () => number; logger?: ConsentsServiceDeps['logger'] }): {
  deps: ConsentsServiceDeps;
  findConsents: Mock<ConsentsRepo['findConsents']>;
  updateConsentsRepo: Mock<ConsentsRepo['updateConsents']>;
  append: Mock<AuditLogWriter['append']>;
} {
  const findConsents = vi.fn<ConsentsRepo['findConsents']>();
  const updateConsentsRepo = vi.fn<ConsentsRepo['updateConsents']>();
  const append = vi.fn<AuditLogWriter['append']>();

  const consentsRepo: ConsentsRepo = {
    findConsents,
    updateConsents: updateConsentsRepo,
  };
  const audit: AuditLogWriter = { append };

  const deps: ConsentsServiceDeps = {
    consentsRepo,
    audit,
    now: overrides?.now ?? (() => Date.parse('2026-01-15T12:00:00.000Z')),
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
  };

  return { deps, findConsents, updateConsentsRepo, append };
}

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('updateConsents — happy path', () => {
  it('persists the new consents and appends a user.consents.updated audit entry', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();
    findConsents.mockResolvedValueOnce(PREVIOUS_CONSENTS);

    const stored: Consents = {
      ...VALID_INPUT,
      version: CURRENT_CGU_VERSION,
      updatedAt: '2026-01-15T12:00:00.000Z',
    };
    updateConsentsRepo.mockResolvedValueOnce(stored);
    append.mockResolvedValueOnce(undefined);

    const result = await updateConsents(USER_ID, VALID_INPUT, deps);

    expect(result).toBe(stored);

    // The repo receives a fully-stamped Consents record.
    expect(updateConsentsRepo).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      marketing: true,
      analytics: true,
      thirdParty: false,
      version: CURRENT_CGU_VERSION,
      updatedAt: '2026-01-15T12:00:00.000Z',
    });

    // Exactly one audit entry, with the documented shape.
    expect(append).toHaveBeenCalledExactlyOnceWith({
      actorId: USER_ID,
      action: 'user.consents.updated',
      targetType: 'user',
      targetId: USER_ID,
      metadata: {
        previousVersion: '2025-06',
        newVersion: CURRENT_CGU_VERSION,
        flags: {
          marketing: true,
          analytics: true,
          thirdParty: false,
        },
      },
    });
  });

  it('records previousVersion = "0000-00" when no prior consents row exists', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();
    findConsents.mockResolvedValueOnce(null);

    const stored: Consents = {
      ...VALID_INPUT,
      version: CURRENT_CGU_VERSION,
      updatedAt: '2026-01-15T12:00:00.000Z',
    };
    updateConsentsRepo.mockResolvedValueOnce(stored);
    append.mockResolvedValueOnce(undefined);

    await updateConsents(USER_ID, VALID_INPUT, deps);

    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0]?.[0];
    expect(entry?.metadata).toMatchObject({
      previousVersion: '0000-00',
      newVersion: CURRENT_CGU_VERSION,
    });
  });

  it('stamps updatedAt from the injected clock (deterministic ISO string)', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps({
      now: () => 1_700_000_000_000,
    });
    findConsents.mockResolvedValueOnce(PREVIOUS_CONSENTS);
    // The repo echoes whatever the service hands it on the happy path.
    updateConsentsRepo.mockImplementationOnce((_userId, consents) => Promise.resolve(consents));
    append.mockResolvedValueOnce(undefined);

    const result = await updateConsents(USER_ID, VALID_INPUT, deps);

    expect(result.updatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(result.version).toBe(CURRENT_CGU_VERSION);
  });
});

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

describe('updateConsents — validation', () => {
  it('rejects a payload missing the marketing flag at path [marketing]', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();

    const err = await updateConsents(USER_ID, { analytics: true, thirdParty: false }, deps).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect((err as MembersError).issues?.some((i) => i.path === 'marketing')).toBe(true);

    // Neither repo nor audit may be touched on a validation failure.
    expect(findConsents).not.toHaveBeenCalled();
    expect(updateConsentsRepo).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects unknown fields via the .strict() schema', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();

    const err = await updateConsents(USER_ID, { ...VALID_INPUT, hacked: true }, deps).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(findConsents).not.toHaveBeenCalled();
    expect(updateConsentsRepo).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects non-object payloads (null, array, primitive)', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();

    for (const bad of [null, 'oops', 42, [], true]) {
      const err = await updateConsents(USER_ID, bad, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MembersError);
      expect((err as MembersError).code).toBe('validation_failed');
    }

    expect(findConsents).not.toHaveBeenCalled();
    expect(updateConsentsRepo).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Error propagation                                                  */
/* ------------------------------------------------------------------ */

describe('updateConsents — error propagation', () => {
  it('still returns the stored consents when audit.append throws, and logs a warning', async () => {
    const warn = vi.fn<NonNullable<ConsentsServiceDeps['logger']>['warn']>();
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps({
      logger: { warn },
    });

    findConsents.mockResolvedValueOnce(PREVIOUS_CONSENTS);
    const stored: Consents = {
      ...VALID_INPUT,
      version: CURRENT_CGU_VERSION,
      updatedAt: '2026-01-15T12:00:00.000Z',
    };
    updateConsentsRepo.mockResolvedValueOnce(stored);
    append.mockRejectedValueOnce(new Error('audit write timeout'));

    const result = await updateConsents(USER_ID, VALID_INPUT, deps);

    // The user-facing contract holds: consents are persisted and returned.
    expect(result).toBe(stored);

    // The warn call must carry enough detail for operators to replay.
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, extra] = warn.mock.calls[0]!;
    expect(msg).toMatch(/audit append failed/i);
    expect(extra).toMatchObject({
      userId: USER_ID,
      error: { name: 'Error', message: 'audit write timeout' },
    });
  });

  it('propagates repo.updateConsents failures and does NOT call audit.append', async () => {
    const { deps, findConsents, updateConsentsRepo, append } = buildDeps();
    findConsents.mockResolvedValueOnce(PREVIOUS_CONSENTS);
    updateConsentsRepo.mockRejectedValueOnce(new Error('db down'));

    const err = await updateConsents(USER_ID, VALID_INPUT, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('db down');
    expect(append).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  needsConsentRefresh — Sprint-4 SP4.2 (S5-013)                      */
/* ================================================================== */

import { NEVER_CONSENTED_VERSION, needsConsentRefresh } from '../consents.js';

describe('needsConsentRefresh (Sprint-4 SP4.2 — S5-013)', () => {
  it('returns true when the user has no recorded version', () => {
    expect(needsConsentRefresh(undefined)).toBe(true);
    expect(needsConsentRefresh(null)).toBe(true);
    expect(needsConsentRefresh('')).toBe(true);
  });

  it('returns true on the legacy sentinel version', () => {
    expect(needsConsentRefresh(NEVER_CONSENTED_VERSION)).toBe(true);
  });

  it('returns true when the user version is older than the current one', () => {
    // CURRENT_CGU_VERSION === '2026-01' — every earlier
    // YYYY-MM string compares strictly less.
    expect(needsConsentRefresh('2025-12')).toBe(true);
    expect(needsConsentRefresh('2024-06')).toBe(true);
    expect(needsConsentRefresh('1999-01')).toBe(true);
  });

  it('returns false when the user is on the current version', () => {
    expect(needsConsentRefresh(CURRENT_CGU_VERSION)).toBe(false);
  });

  it('returns false when the user is on a future version (forward compat)', () => {
    // A user who has consented to a newer version than what
    // this build knows about does NOT need to be re-prompted —
    // a stale build that triggered a re-consent loop would
    // burn user trust. The forward-compat guard handles a
    // staged rollout where a new mobile build (with the bumped
    // CURRENT_CGU_VERSION) lands before the web build catches up.
    expect(needsConsentRefresh('2026-02')).toBe(false);
    expect(needsConsentRefresh('2027-12')).toBe(false);
  });
});
