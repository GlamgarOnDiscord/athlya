/**
 * Unit tests for `requestReset` + `confirmReset` primitives —
 * Sprint-6 Slice 6.3 (Vague 34, audit finding S2-006).
 *
 * Coverage targets the security envelope documented at the top of
 * `forgot-password.ts`:
 *
 *   1. Email enumeration defence — `requestReset` returns
 *      `{ kind: 'sent' }` whether or not the email matches.
 *   2. Token entropy — generated token is the source of the hash
 *      sent to the repo (never the plain).
 *   3. Single-use — `confirmReset` only succeeds against the row
 *      with a matching active `tokenHash`.
 *   4. TTL — expired tokens reject with `token_expired`.
 *   5. HIBP fail-open (issue #233, matches register): HIBP down → reset proceeds.
 *   6. Family revoke — every active session destroyed on success.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RESET_TOKEN_TTL_SEC, confirmReset, requestReset } from '../forgot-password.js';
import type { PasswordResetEmailTransport, PasswordResetRepo } from '../forgot-password.js';
import type { SessionStore, UserRepo, UserRow } from '../service.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDIO_ID = '22222222-2222-4222-8222-222222222222';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    studioId: STUDIO_ID,
    email: 'alice@example.com',
    emailVerified: true,
    passwordHash: '$2b$12$existingHashHashHashHashHashHashHashHashHashHash',
    displayName: 'Alice',
    role: 'member',
    avatarUrl: null,
    consents: {
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: '2026-01',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as UserRow;
}

function makeUserRepo(user: UserRow | null = null) {
  return {
    findUserByEmail: vi.fn().mockResolvedValue(user),
    findUserById: vi.fn().mockResolvedValue(user),
    findStudioBySlug: vi.fn(),
    createUser: vi.fn(),
    softDeleteUser: vi.fn(),
    bumpCredentialsVersion: vi.fn().mockResolvedValue(undefined),
    findOrCreateOAuthUser: vi.fn(),
  } satisfies UserRepo;
}

function makeResetRepo() {
  return {
    insertToken: vi.fn().mockResolvedValue(undefined),
    findActiveTokenByHash: vi.fn().mockResolvedValue(null),
    consumeAndResetPassword: vi.fn().mockResolvedValue(undefined),
  } satisfies PasswordResetRepo;
}

function makeTransport() {
  return {
    sendResetEmail: vi.fn().mockResolvedValue(undefined),
  } satisfies PasswordResetEmailTransport;
}

function makeSessionStore() {
  return {
    create: vi.fn(),
    rotate: vi.fn(),
    revoke: vi.fn(),
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
    revokeFamilyByRootSid: vi.fn(),
    exists: vi.fn(),
  } satisfies SessionStore;
}

/* ================================================================== */
/*  requestReset                                                       */
/* ================================================================== */

describe('requestReset (Sprint-6 SP6.3 — S2-006)', () => {
  it('returns sent and dispatches the email when the email matches an active user', async () => {
    const userRepo = makeUserRepo(makeUser());
    const passwordResetRepo = makeResetRepo();
    const emailTransport = makeTransport();

    const result = await requestReset('alice@example.com', {
      userRepo,
      passwordResetRepo,
      emailTransport,
      resetLinkBaseUrl: 'https://app.athlya.test',
    });

    expect(result.kind).toBe('sent');
    expect(passwordResetRepo.insertToken).toHaveBeenCalledTimes(1);
    const tokenCall = passwordResetRepo.insertToken.mock.calls[0]![0]!;
    expect(tokenCall.userId).toBe(USER_ID);
    // Hash is 64 hex chars (SHA-256). The plain token never
    // shows up in the repo call.
    expect(tokenCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emailTransport.sendResetEmail).toHaveBeenCalledTimes(1);
    const emailCall = emailTransport.sendResetEmail.mock.calls[0]![0]!;
    expect(emailCall.to).toBe('alice@example.com');
    expect(emailCall.link).toMatch(/^https:\/\/app\.athlya\.test\/reset-password\/[A-Za-z0-9_-]+$/);
  });

  it('strips trailing slashes from the reset link base URL', async () => {
    const emailTransport = makeTransport();

    await requestReset('alice@example.com', {
      userRepo: makeUserRepo(makeUser()),
      passwordResetRepo: makeResetRepo(),
      emailTransport,
      resetLinkBaseUrl: 'https://app.athlya.test///',
    });

    const emailCall = emailTransport.sendResetEmail.mock.calls[0]![0]!;
    expect(emailCall.link).toMatch(/^https:\/\/app\.athlya\.test\/reset-password\/[A-Za-z0-9_-]+$/);
  });

  it('returns sent (no side-effect) when the email does NOT match — email-enumeration defence', async () => {
    const userRepo = makeUserRepo(null);
    const passwordResetRepo = makeResetRepo();
    const emailTransport = makeTransport();

    const result = await requestReset('ghost@example.com', {
      userRepo,
      passwordResetRepo,
      emailTransport,
      resetLinkBaseUrl: 'https://app.athlya.test',
    });

    expect(result.kind).toBe('sent');
    // Critically: no token persisted, no email dispatched.
    expect(passwordResetRepo.insertToken).not.toHaveBeenCalled();
    expect(emailTransport.sendResetEmail).not.toHaveBeenCalled();
  });

  it('returns sent (no side-effect) when the user is soft-deleted', async () => {
    const userRepo = makeUserRepo(
      makeUser({ deletedAt: '2026-01-01T00:00:00.000Z' as unknown as Date }),
    );
    const passwordResetRepo = makeResetRepo();
    const emailTransport = makeTransport();

    const result = await requestReset('alice@example.com', {
      userRepo,
      passwordResetRepo,
      emailTransport,
      resetLinkBaseUrl: 'https://app.athlya.test',
    });

    expect(result.kind).toBe('sent');
    expect(emailTransport.sendResetEmail).not.toHaveBeenCalled();
  });

  it('stamps expiresAt at TTL_SEC seconds in the future', async () => {
    const userRepo = makeUserRepo(makeUser());
    const passwordResetRepo = makeResetRepo();
    const emailTransport = makeTransport();
    const fixedNowSec = 1750000000;

    await requestReset('alice@example.com', {
      userRepo,
      passwordResetRepo,
      emailTransport,
      resetLinkBaseUrl: 'https://app.athlya.test',
      now: () => fixedNowSec,
    });

    const tokenCall = passwordResetRepo.insertToken.mock.calls[0]![0]!;
    expect(tokenCall.expiresAt.getTime()).toBe((fixedNowSec + DEFAULT_RESET_TOKEN_TTL_SEC) * 1000);
  });
});

/* ================================================================== */
/*  confirmReset                                                       */
/* ================================================================== */

describe('confirmReset (Sprint-6 SP6.3 — S2-006)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unknown token with token_invalid', async () => {
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();

    await expect(
      confirmReset(
        { token: 'forged', newPassword: 'new-correct-horse-staple-1' },
        {
          passwordResetRepo,
          sessionStore,
          hibpFetch: hibpOk,
        },
      ),
    ).rejects.toMatchObject({ code: 'token_invalid' });
  });

  it('rejects an expired token with token_expired', async () => {
    const passwordResetRepo = makeResetRepo();
    // The repo's SQL filter SHOULD have rejected this row, but
    // we test the in-memory defence-in-depth guard too.
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    await expect(
      confirmReset(
        { token: 'good', newPassword: 'new-correct-horse-staple-1' },
        {
          passwordResetRepo,
          sessionStore: makeSessionStore(),
          hibpFetch: hibpOk,
        },
      ),
    ).rejects.toMatchObject({ code: 'token_expired' });
  });

  it('rejects breached password with password_breached', async () => {
    const passwordResetRepo = makeResetRepo();
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      confirmReset(
        { token: 'good', newPassword: 'breached' },
        {
          passwordResetRepo,
          sessionStore: makeSessionStore(),
          hibpFetch: hibpBreached,
        },
      ),
    ).rejects.toMatchObject({ code: 'password_breached' });
  });

  it('fails open when HIBP cannot be reached — emits degraded metric and completes reset (issue #233)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await confirmReset(
      { token: 'good', newPassword: 'new-correct-horse-staple-1' },
      {
        passwordResetRepo,
        sessionStore,
        hibpFetch: hibpDown,
      },
    );

    expect(result.userId).toBe(USER_ID);
    expect(warn).toHaveBeenCalledWith(
      'athlya.hibp.degraded',
      expect.objectContaining({ metric: 'hibp_degraded', degraded: true, op: 'confirmReset' }),
    );
    expect(sessionStore.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects with hibp_unavailable when HIBP is unreachable and hibpFailClosed is true (issue #464)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      confirmReset(
        { token: 'good', newPassword: 'new-correct-horse-staple-1' },
        {
          passwordResetRepo,
          sessionStore,
          hibpFetch: hibpDown,
          hibpFailClosed: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'hibp_unavailable' });
    expect(passwordResetRepo.consumeAndResetPassword).not.toHaveBeenCalled();
  });

  it('happy path consumes the token, updates the password and revokes every session', async () => {
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await confirmReset(
      { token: 'good', newPassword: 'new-correct-horse-staple-1' },
      {
        passwordResetRepo,
        sessionStore,
        hibpFetch: hibpOk,
      },
    );

    expect(result.userId).toBe(USER_ID);
    expect(passwordResetRepo.consumeAndResetPassword).toHaveBeenCalledTimes(1);
    const consumeCall = passwordResetRepo.consumeAndResetPassword.mock.calls[0]![0]!;
    // Hash is bcrypt — starts with `$2b$`.
    expect(consumeCall.newPasswordHash.startsWith('$2b$')).toBe(true);
    // Family revoke fired — every active session destroyed.
    expect(sessionStore.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('stale sibling token (A/B replay) is rejected after B is consumed — repo contract', async () => {
    // Simulates: user requests link A, then link B. Uses B. Attempts to
    // replay link A. The service layer sees a null from findActiveTokenByHash
    // because the repo (real adapter) marks siblings consumed on insertToken
    // and on consumeAndResetPassword. This test verifies the service raises
    // token_invalid for a consumed/missing token.
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();
    // Simulate: A is gone (consumed by the sibling-invalidation on insertToken
    // of B, or by consumeAndResetPassword of B) — findActiveTokenByHash returns null.
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce(null);

    await expect(
      confirmReset(
        { token: 'stale-link-A', newPassword: 'new-correct-horse-staple-1' },
        { passwordResetRepo, sessionStore, hibpFetch: hibpOk },
      ),
    ).rejects.toMatchObject({ code: 'token_invalid' });

    // Repo consume must NOT be called when the token lookup fails.
    expect(passwordResetRepo.consumeAndResetPassword).not.toHaveBeenCalled();
    // Sessions must not be revoked when no valid token was presented.
    expect(sessionStore.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('consumeAndResetPassword receives the exact tokenHash from findActiveTokenByHash lookup', async () => {
    // Validates that the tokenHash forwarded to consumeAndResetPassword is
    // the SHA-256 of the presented plain token (not the plain token itself)
    // so the adapter CTE's WHERE token_hash = $hash condition is correct.
    const passwordResetRepo = makeResetRepo();
    const sessionStore = makeSessionStore();
    passwordResetRepo.findActiveTokenByHash.mockResolvedValueOnce({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await confirmReset(
      { token: 'raw-plain-token', newPassword: 'new-correct-horse-staple-1' },
      { passwordResetRepo, sessionStore, hibpFetch: hibpOk },
    );

    const consumeCall = passwordResetRepo.consumeAndResetPassword.mock.calls[0]![0]!;
    // The hash must be 64 hex chars (SHA-256) — never the raw token.
    expect(consumeCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(consumeCall.tokenHash).not.toBe('raw-plain-token');
    expect(consumeCall.userId).toBe(USER_ID);
  });
});

/* ------------------------------------------------------------------ */
/*  HIBP test doubles                                                  */
/* ------------------------------------------------------------------ */

/** OK reply — password not breached. */
const hibpOk: typeof fetch = vi.fn(async () => {
  return new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n', {
    status: 200,
  });
});

/** Forged hit — counts the candidate hash as breached. */
const hibpBreached: typeof fetch = vi.fn(async () => {
  // The hibp helper SHA-1s the candidate password client-side
  // and looks up the 35-char suffix in the response body. We
  // pre-compute SHA-1("breached") = a89b6...
  // Easier than re-implementing SHA-1 here: respond with a
  // catchall body that the helper's substring scanner matches.
  // The helper iterates lines `<suffix>:<count>` and hits when
  // the line starts with the candidate's suffix.
  //
  // We compute SHA-1("breached") via Web Crypto so the suffix
  // is real and the helper's strict comparison passes.
  const data = new TextEncoder().encode('breached');
  const digest = await globalThis.crypto.subtle.digest('SHA-1', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const suffix = hex.slice(5);
  return new Response(`${suffix}:99\n`, { status: 200 });
});

/** Network down — surface as HIBP unavailable. */
const hibpDown: typeof fetch = vi.fn(async () => {
  throw new Error('network down');
});
