/**
 * Unit tests for `@athlya/auth/service`.
 *
 * These exercise every path of the seven use cases described in task
 * 3.3 against the requirements they implement:
 *
 *   - register  → Req 1.1, 1.2, 5.1-style event emission.
 *   - login     → Req 1.5, 1.6, opaque failure semantics.
 *   - refresh   → Req 2.2 (rotation invalidates old sid).
 *   - logout    → idempotent revoke.
 *   - deleteMe  → Req 5.1 (`auth.user.deleted` emission + session wipe).
 *   - loginWithApple / loginWithGoogle → Req 1.4 (JWKS verification).
 *
 * The suite uses `vi.fn()` mocks for {@link UserRepo}, {@link SessionStore},
 * {@link OAuthVerifier} and the event publisher. The cryptographic
 * layer is real: we mint a throwaway RS256 key pair once per suite so
 * the JWT sign/verify round-trip is exercised end-to-end. This keeps
 * the test a true unit test of the service orchestration (no I/O)
 * while still catching any drift between the signing and verifying
 * paths.
 */

import { SignJWT, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

/**
 * Decode a compact JWS header segment without verifying the
 * signature. Used by the Req 2.1 assertion to confirm the service
 * stamps `alg: 'RS256'` on every access token it issues. We
 * intentionally DO NOT delegate to `jose.decodeProtectedHeader` — a
 * minimal hand-rolled decoder keeps this test hermetic and makes the
 * intent obvious (we only care about the header bits, not the
 * cryptographic verification that the jose helpers perform
 * elsewhere in the suite).
 */
function decodeJwtHeader(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`decodeJwtHeader: token is not a 3-segment JWS: ${token}`);
  }
  const headerSeg = parts[0] ?? '';
  const padded = headerSeg
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(headerSeg.length + ((4 - (headerSeg.length % 4)) % 4), '=');
  const json = globalThis.atob(padded);
  return JSON.parse(json) as Record<string, unknown>;
}

import { currentJwks, publicJwkOf } from '../jwt.js';
import { hash as hashPassword } from '../password.js';
import {
  AuthError,
  CURRENT_CGU_VERSION,
  EmailTakenError,
  deleteMe,
  login,
  loginWithApple,
  loginWithGoogle,
  logout,
  logoutAll,
  refresh,
  register,
} from '../service.js';

import type { Jwks, SigningKey } from '../jwt.js';
import type {
  AuthServiceDeps,
  OAuthVerifier,
  SessionStore,
  Session,
  UserRepo,
  UserRow,
} from '../service.js';
import type { LoginRequest, RegisterRequest } from '@athlya/shared/schemas/api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW_SEC = 1_700_000_000;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDIO_ID = '22222222-2222-4222-8222-222222222222';
const SID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const EVENT_ID_1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

const REGISTER_INPUT: RegisterRequest = {
  email: 'alice@example.com',
  password: 'CorrectHorseBatteryStaple!1',
  displayName: 'Alice',
  studioSlug: 'athlya-studio',
  consents: { marketing: true, analytics: false, thirdParty: false },
};

const LOGIN_INPUT: LoginRequest = {
  email: 'alice@example.com',
  password: 'CorrectHorseBatteryStaple!1',
};

let signingKey: SigningKey;
let jwks: Jwks;

// Precomputed SHA-1 prefix/suffix of REGISTER_INPUT.password — used by
// the HIBP fetch stub to return a breached-style body only when the
// request prefix actually matches the password we're registering with.
const registerPasswordHash: { prefix: string; suffix: string } = {
  prefix: '',
  suffix: '',
};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  signingKey = { kid: 'kid-test', privateKey, publicKey };
  jwks = currentJwks([{ kid: signingKey.kid, publicKey: await publicJwkOf(signingKey) }]);

  const bytes = new TextEncoder().encode(REGISTER_INPUT.password);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  hex = hex.toUpperCase();
  registerPasswordHash.prefix = hex.slice(0, 5);
  registerPasswordHash.suffix = hex.slice(5);
});

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

interface MockedRepo extends UserRepo {
  findUserByEmail: MockedFunction<UserRepo['findUserByEmail']>;
  findUserById: MockedFunction<UserRepo['findUserById']>;
  findStudioBySlug: MockedFunction<UserRepo['findStudioBySlug']>;
  createUser: MockedFunction<UserRepo['createUser']>;
  softDeleteUser: MockedFunction<UserRepo['softDeleteUser']>;
  bumpCredentialsVersion: MockedFunction<UserRepo['bumpCredentialsVersion']>;
  findOrCreateOAuthUser: MockedFunction<UserRepo['findOrCreateOAuthUser']>;
}

function makeRepo(): MockedRepo {
  return {
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    findStudioBySlug: vi.fn(),
    createUser: vi.fn(),
    softDeleteUser: vi.fn(),
    bumpCredentialsVersion: vi.fn().mockResolvedValue(undefined),
    findOrCreateOAuthUser: vi.fn(),
  };
}

interface MockedStore extends SessionStore {
  create: MockedFunction<SessionStore['create']>;
  rotate: MockedFunction<SessionStore['rotate']>;
  revoke: MockedFunction<SessionStore['revoke']>;
  revokeAllForUser: MockedFunction<SessionStore['revokeAllForUser']>;
  revokeFamilyByRootSid: MockedFunction<SessionStore['revokeFamilyByRootSid']>;
  exists: MockedFunction<SessionStore['exists']>;
}

function makeStore(): MockedStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    // Default: happy-path rotate returning the SP2.1
    // discriminated `ok` shape. Tests that need to exercise
    // `unknown` / `reuse_detected` override per-call via
    // `mockResolvedValueOnce({ kind: 'unknown' })` etc.
    rotate: vi.fn().mockResolvedValue({
      kind: 'ok',
      userId: USER_ID,
      rootSid: SID_1,
    }),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
    revokeFamilyByRootSid: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  };
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    studioId: STUDIO_ID,
    email: 'alice@example.com',
    displayName: 'Alice',
    role: 'member',
    passwordHash: null,
    deletedAt: null,
    credentialsVersion: 1,
    ...overrides,
  };
}

/**
 * Build a deps bundle with deterministic `now`, `uuid`, a fake HIBP
 * fetch and all `UserRepo` / `SessionStore` methods stubbed.
 */
function makeDeps(
  options: {
    repo?: MockedRepo;
    store?: MockedStore;
    uuids?: string[];
    nowSec?: number;
    publishEvent?: MockedFunction<AuthServiceDeps['publishEvent']>;
    hibpBreached?: boolean;
    hibpFail?: boolean;
    oauthVerifier?: OAuthVerifier;
  } = {},
): {
  deps: AuthServiceDeps;
  repo: MockedRepo;
  store: MockedStore;
  publishEvent: MockedFunction<AuthServiceDeps['publishEvent']>;
} {
  const repo = options.repo ?? makeRepo();
  const store = options.store ?? makeStore();
  const publishEvent =
    options.publishEvent ?? vi.fn<AuthServiceDeps['publishEvent']>(() => Promise.resolve());
  const uuidQueue = [...(options.uuids ?? [SID_1, EVENT_ID_1, SID_2])];

  const hibpFetch: typeof fetch = options.hibpFail
    ? vi.fn(() => Promise.reject(new Error('network down')))
    : vi.fn((url: Parameters<typeof fetch>[0]) => {
        const urlString = typeof url === 'string' ? url : (url as URL).toString();
        const urlPrefix = urlString.split('/').pop() ?? '';
        const body =
          options.hibpBreached && urlPrefix === registerPasswordHash.prefix
            ? `${registerPasswordHash.suffix}:5\n`
            : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n';
        return Promise.resolve(new Response(body, { status: 200 }));
      });

  const deps: AuthServiceDeps = {
    userRepo: repo,
    sessionStore: store,
    signingKey,
    jwks,
    publishEvent,
    now: () => options.nowSec ?? FIXED_NOW_SEC,
    uuid: () => uuidQueue.shift() ?? `extra-uuid-${String(uuidQueue.length)}`,
    hibpFetch,
    ...(options.oauthVerifier !== undefined ? { oauthVerifier: options.oauthVerifier } : {}),
  };
  return { deps, repo, store, publishEvent };
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe('register', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with studio_not_found when the slug does not resolve', async () => {
    const { deps, repo } = makeDeps();
    repo.findStudioBySlug.mockResolvedValue(null);

    await expect(register(REGISTER_INPUT, deps)).rejects.toMatchObject({
      code: 'studio_not_found',
    });
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('rejects with password_breached when HIBP flags the password', async () => {
    const { deps, repo } = makeDeps({ hibpBreached: true });
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });

    await expect(register(REGISTER_INPUT, deps)).rejects.toMatchObject({
      code: 'password_breached',
    });
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('fails open when HIBP cannot be reached — emits degraded metric and allows registration (issue #233)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, repo } = makeDeps({ hibpFail: true });
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    repo.createUser.mockResolvedValue(makeUserRow());

    const session = await register(REGISTER_INPUT, deps);

    expect(session.user.id).toBe(USER_ID);
    expect(warn).toHaveBeenCalledWith(
      'athlya.hibp.degraded',
      expect.objectContaining({ metric: 'hibp_degraded', degraded: true, op: 'register' }),
    );
  });

  it('rejects with hibp_unavailable when HIBP is unreachable and hibpFailClosed is true (issue #464)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, repo } = makeDeps({ hibpFail: true });
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });

    await expect(register(REGISTER_INPUT, { ...deps, hibpFailClosed: true })).rejects.toMatchObject(
      { code: 'hibp_unavailable' },
    );
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('rejects with email_taken when the repo reports a unique-email collision', async () => {
    const { deps, repo } = makeDeps();
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    repo.createUser.mockRejectedValue(new EmailTakenError());

    await expect(register(REGISTER_INPUT, deps)).rejects.toMatchObject({
      code: 'email_taken',
    });
  });

  it('returns a Session and publishes auth.user.registered on the happy path', async () => {
    const { deps, repo, store, publishEvent } = makeDeps();
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    repo.createUser.mockImplementation(
      (input: {
        studioId: string;
        email: string;
        passwordHash: string | null;
        displayName: string;
        role: 'member' | 'coach' | 'admin';
      }): Promise<UserRow> =>
        Promise.resolve({
          id: USER_ID,
          studioId: input.studioId,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          passwordHash: input.passwordHash,
          deletedAt: null,
          credentialsVersion: 1,
        }),
    );

    const session: Session = await register(REGISTER_INPUT, deps);

    expect(session.user.id).toBe(USER_ID);
    expect(session.accessToken.split('.').length).toBe(3);
    expect(session.refreshToken.split('.').length).toBe(3);
    expect(session.accessExp).toBe(FIXED_NOW_SEC + 15 * 60);
    expect(session.refreshExp).toBe(FIXED_NOW_SEC + 30 * 24 * 60 * 60);
    expect(session.sid).toBe(SID_1);

    const createCall = repo.createUser.mock.calls[0]![0] as {
      consents: { version: string };
    };
    expect(createCall.consents.version).toBe(CURRENT_CGU_VERSION);

    expect(store.create).toHaveBeenCalledWith(USER_ID, SID_1, expect.any(Date));

    expect(publishEvent).toHaveBeenCalledTimes(1);
    const event = publishEvent.mock.calls[0]?.[0] as {
      type: string;
      payload: { userId: string };
    };
    expect(event.type).toBe('auth.user.registered');
    expect(event.payload.userId).toBe(USER_ID);
    // Sprint-2 SP2.2 (S5-005): email was removed from the
    // payload — consumers fetch it from the user repo. Assert
    // explicitly that it does NOT leak onto the bus envelope.
    expect((event.payload as Record<string, unknown>)['email']).toBeUndefined();
  });

  it('hashes the password with bcrypt at cost 12 before persisting (Req 1.1)', async () => {
    const { deps, repo } = makeDeps();
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    repo.createUser.mockImplementation(
      (input: {
        studioId: string;
        email: string;
        passwordHash: string | null;
        displayName: string;
        role: 'member' | 'coach' | 'admin';
      }): Promise<UserRow> =>
        Promise.resolve({
          id: USER_ID,
          studioId: input.studioId,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          passwordHash: input.passwordHash,
          deletedAt: null,
          credentialsVersion: 1,
        }),
    );

    await register(REGISTER_INPUT, deps);

    const createCall = repo.createUser.mock.calls[0]?.[0] as {
      passwordHash: string | null;
    };
    // bcrypt-format: `$2<a|b|y>$<cost>$<22-char salt><31-char hash>`.
    // We pin the cost segment to "12" to enforce Req 1.1; the
    // variant prefix (`$2a$`, `$2b$`, `$2y$`) is allowed to drift
    // across bcrypt implementations.
    expect(createCall.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('login', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with invalid_credentials when the user does not exist', async () => {
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(null);

    await expect(login(LOGIN_INPUT, deps)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('rejects with invalid_credentials when the user is soft-deleted', async () => {
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ deletedAt: new Date() }));

    await expect(login(LOGIN_INPUT, deps)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('rejects with invalid_credentials when the user has no password set (OAuth-only)', async () => {
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: null }));

    await expect(login(LOGIN_INPUT, deps)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('rejects with invalid_credentials when the password does not match', async () => {
    const storedHash = await hashPassword('the-right-password');
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    await expect(login(LOGIN_INPUT, deps)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('rejects with rate_limited when the gateway throttle decision says deny', async () => {
    const { deps } = makeDeps();
    await expect(
      login(LOGIN_INPUT, deps, { throttle: { allow: false, retryAfterSec: 42 } }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retryAfterSec: 42 },
    });
  });

  it('issues a Session when credentials are correct', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const session = await login(LOGIN_INPUT, deps);
    expect(session.user.id).toBe(USER_ID);
    expect(session.accessToken.split('.').length).toBe(3);
    expect(store.create).toHaveBeenCalledWith(USER_ID, SID_1, expect.any(Date));
  });

  it('issues tokens with 15-minute access / 30-day refresh TTLs (Req 1.5, 2.1, 2.2)', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const session = await login(LOGIN_INPUT, deps);

    // Req 1.5 / 2.1: access token TTL is 15 minutes.
    expect(session.accessExp).toBe(FIXED_NOW_SEC + 15 * 60);
    // Req 2.2: refresh token TTL is 30 days.
    expect(session.refreshExp).toBe(FIXED_NOW_SEC + 30 * 24 * 60 * 60);
  });

  it('signs the access token with RS256 (Req 2.1)', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const session = await login(LOGIN_INPUT, deps);
    const header = decodeJwtHeader(session.accessToken);
    expect(header['alg']).toBe('RS256');
    expect(header['typ']).toBe('JWT');
    expect(header['kid']).toBe(signingKey.kid);
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('refresh', () => {
  it('rejects with token_expired on an expired refresh token', async () => {
    const pastNow = FIXED_NOW_SEC - (30 * 24 * 60 * 60 + 10);
    const expiredToken = await new SignJWT({ sub: USER_ID, sid: SID_1 })
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'JWT',
        kid: signingKey.kid,
      })
      .setIssuedAt(pastNow)
      .setExpirationTime(pastNow + 60)
      .setSubject(USER_ID)
      .sign(signingKey.privateKey);

    const { deps } = makeDeps();
    await expect(refresh(expiredToken, deps)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('rejects with token_invalid when the session store rotate returns unknown', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps({
      uuids: [SID_1, SID_2],
    });
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    repo.findUserById.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const initial = await login(LOGIN_INPUT, deps);
    store.rotate.mockResolvedValueOnce({ kind: 'unknown' });

    await expect(refresh(initial.refreshToken, deps)).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('rotates the session and issues a new token pair on success', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps({
      uuids: [SID_1, SID_2],
    });
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    repo.findUserById.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const initial = await login(LOGIN_INPUT, deps);
    const rotated = await refresh(initial.refreshToken, deps);

    expect(rotated.sid).toBe(SID_2);
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(store.rotate).toHaveBeenCalledWith(SID_1, SID_2, expect.any(Date));
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  it('revokes the sid carried by a valid refresh token', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));

    const session = await login(LOGIN_INPUT, deps);
    await logout(session.refreshToken, deps);
    expect(store.revoke).toHaveBeenCalledWith(SID_1);
  });

  it('is idempotent when called twice with the same refresh token', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    const session = await login(LOGIN_INPUT, deps);

    await logout(session.refreshToken, deps);
    await logout(session.refreshToken, deps);
    expect(store.revoke).toHaveBeenCalledTimes(2);
  });

  it('never revokes the other sessions of the user (S2-010)', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    const session = await login(LOGIN_INPUT, deps);

    await logout(session.refreshToken, deps, { userId: USER_ID });

    expect(store.revoke).toHaveBeenCalledWith(SID_1);
    expect(store.revokeAllForUser).not.toHaveBeenCalled();
    expect(store.revokeFamilyByRootSid).not.toHaveBeenCalled();
  });

  it('rejects a refresh token of another user and revokes nothing', async () => {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo, store } = makeDeps();
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    const session = await login(LOGIN_INPUT, deps);

    await expect(
      logout(session.refreshToken, deps, { userId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toMatchObject({ code: 'token_invalid' });
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('rejects an expired refresh token of another user and revokes nothing', async () => {
    const pastNow = FIXED_NOW_SEC - (30 * 24 * 60 * 60 + 10);
    const expiredToken = await new SignJWT({ sub: USER_ID, sid: SID_1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: signingKey.kid })
      .setIssuedAt(pastNow)
      .setExpirationTime(pastNow + 60)
      .setSubject(USER_ID)
      .sign(signingKey.privateKey);
    const { deps, store } = makeDeps();

    await expect(
      logout(expiredToken, deps, { userId: '99999999-9999-4999-8999-999999999999' }),
    ).rejects.toMatchObject({ code: 'token_invalid' });
    expect(store.revoke).not.toHaveBeenCalled();

    await logout(expiredToken, deps, { userId: USER_ID });
    expect(store.revoke).toHaveBeenCalledWith(SID_1);
  });
});

/**
 * Minimal live-session ledger: `sid → userId`, with the same revoke
 * semantics as the Redis store (rotation consumes the old sid).
 */
function makeMemoryStore(): SessionStore {
  const live = new Map<string, string>();
  return {
    create: (userId, sid) => {
      live.set(sid, userId);
      return Promise.resolve();
    },
    rotate: (oldSid, newSid) => {
      const userId = live.get(oldSid);
      if (userId === undefined) return Promise.resolve({ kind: 'unknown' } as const);
      live.delete(oldSid);
      live.set(newSid, userId);
      return Promise.resolve({ kind: 'ok', userId, rootSid: oldSid } as const);
    },
    revoke: (sid) => {
      live.delete(sid);
      return Promise.resolve();
    },
    revokeAllForUser: (userId) => {
      for (const [sid, owner] of live) {
        if (owner === userId) live.delete(sid);
      }
      return Promise.resolve();
    },
    revokeFamilyByRootSid: () => Promise.resolve(),
    exists: (sid) => Promise.resolve(live.has(sid)),
  };
}

describe('logout vs logoutAll across sessions (S2-010)', () => {
  async function twoSessions() {
    const storedHash = await hashPassword(LOGIN_INPUT.password);
    const { deps, repo } = makeDeps({
      store: makeMemoryStore() as MockedStore,
      uuids: ['sid-a', 'sid-b', 'sid-a2', 'sid-b2', 'sid-b3'],
    });
    repo.findUserByEmail.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    repo.findUserById.mockResolvedValue(makeUserRow({ passwordHash: storedHash }));
    const phone = await login(LOGIN_INPUT, deps);
    const laptop = await login(LOGIN_INPUT, deps);
    return { deps, phone, laptop };
  }

  it('logout ends the presented session and leaves the other one refreshable', async () => {
    const { deps, phone, laptop } = await twoSessions();

    await logout(phone.refreshToken, deps, { userId: USER_ID });

    await expect(refresh(phone.refreshToken, deps)).rejects.toMatchObject({
      code: 'token_invalid',
    });
    const rotated = await refresh(laptop.refreshToken, deps);
    expect(rotated.user.id).toBe(USER_ID);
  });

  it('logoutAll ends every session of the user', async () => {
    const { deps, phone, laptop } = await twoSessions();

    await logoutAll(USER_ID, deps);

    await expect(refresh(phone.refreshToken, deps)).rejects.toMatchObject({
      code: 'token_invalid',
    });
    await expect(refresh(laptop.refreshToken, deps)).rejects.toMatchObject({
      code: 'token_invalid',
    });
    expect(deps.userRepo.bumpCredentialsVersion).toHaveBeenCalledWith(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// deleteMe
// ---------------------------------------------------------------------------

describe('deleteMe', () => {
  it('rejects with not_found when the user does not exist', async () => {
    const { deps, repo } = makeDeps();
    repo.findUserById.mockResolvedValue(null);

    await expect(deleteMe(USER_ID, deps)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('soft-deletes the user, revokes sessions and publishes auth.user.deleted', async () => {
    const { deps, repo, store, publishEvent } = makeDeps();
    repo.findUserById.mockResolvedValue(makeUserRow());

    await deleteMe(USER_ID, deps);

    expect(repo.softDeleteUser).toHaveBeenCalledWith(USER_ID);
    expect(store.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    const event = publishEvent.mock.calls[0]?.[0] as {
      type: string;
      payload: { userId: string };
    };
    expect(event.type).toBe('auth.user.deleted');
    expect(event.payload.userId).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// Durable auth events (issue #411)
// ---------------------------------------------------------------------------

describe('durable auth events (issue #411)', () => {
  it('register records auth.user.registered with the user, then dispatches it best-effort', async () => {
    const { deps, repo, publishEvent } = makeDeps();
    const dispatchRecordedEvent = vi.fn<NonNullable<AuthServiceDeps['dispatchRecordedEvent']>>(() =>
      Promise.reject(new Error('queue down')),
    );
    const durableDeps: AuthServiceDeps = { ...deps, dispatchRecordedEvent };
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    const createUserWithEvent = vi.fn<NonNullable<UserRepo['createUserWithEvent']>>(
      (input, buildEvent) => {
        const event = buildEvent({ id: USER_ID, studioId: input.studioId }) as unknown as {
          type: string;
          payload: { userId: string };
        };
        expect(event.type).toBe('auth.user.registered');
        expect(event.payload.userId).toBe(USER_ID);
        return Promise.resolve(makeUserRow({ studioId: input.studioId }));
      },
    );
    const durableRepo: UserRepo = { ...repo, createUserWithEvent };

    const session = await register(REGISTER_INPUT, { ...durableDeps, userRepo: durableRepo });

    expect(session.user.id).toBe(USER_ID);
    expect(createUserWithEvent).toHaveBeenCalledTimes(1);
    expect(repo.createUser).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(dispatchRecordedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth.user.registered' }),
    );
  });

  it('register fails when the user + event cannot be recorded together', async () => {
    const { deps, repo, publishEvent, store } = makeDeps();
    repo.findStudioBySlug.mockResolvedValue({
      id: STUDIO_ID,
      slug: 'athlya-studio',
      name: 'Athlya',
    });
    const durableRepo: UserRepo = {
      ...repo,
      createUserWithEvent: vi.fn(() => Promise.reject(new Error('outbox unavailable'))),
    };

    await expect(register(REGISTER_INPUT, { ...deps, userRepo: durableRepo })).rejects.toThrow(
      'outbox unavailable',
    );
    expect(store.create).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('deleteMe tombstones and records auth.user.deleted atomically before revoking sessions', async () => {
    const { deps, repo, store, publishEvent } = makeDeps();
    repo.findUserById.mockResolvedValue(makeUserRow());
    const softDeleteUserWithEvent = vi.fn<NonNullable<UserRepo['softDeleteUserWithEvent']>>(() =>
      Promise.resolve(),
    );
    const dispatchRecordedEvent = vi.fn<NonNullable<AuthServiceDeps['dispatchRecordedEvent']>>(() =>
      Promise.resolve(),
    );

    await deleteMe(USER_ID, {
      ...deps,
      dispatchRecordedEvent,
      userRepo: { ...repo, softDeleteUserWithEvent },
    });

    const [id, event] = softDeleteUserWithEvent.mock.calls[0]!;
    expect(id).toBe(USER_ID);
    expect(event).toMatchObject({
      type: 'auth.user.deleted',
      studioId: STUDIO_ID,
      payload: { userId: USER_ID },
    });
    expect(repo.softDeleteUser).not.toHaveBeenCalled();
    expect(store.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(dispatchRecordedEvent).toHaveBeenCalledWith(event);
  });

  it('deleteMe surfaces a recording failure and keeps the sessions', async () => {
    const { deps, repo, store } = makeDeps();
    repo.findUserById.mockResolvedValue(makeUserRow());

    await expect(
      deleteMe(USER_ID, {
        ...deps,
        userRepo: {
          ...repo,
          softDeleteUserWithEvent: vi.fn(() => Promise.reject(new Error('42501'))),
        },
      }),
    ).rejects.toThrow('42501');
    expect(store.revokeAllForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loginWithApple / loginWithGoogle
// ---------------------------------------------------------------------------

describe('loginWithApple / loginWithGoogle', () => {
  it('rejects with oauth_verification_failed when the Apple verifier throws', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.reject(new Error('bad signature'))),
    };
    const { deps } = makeDeps({ oauthVerifier: verifier });

    await expect(loginWithApple('eyJ.bad.token', deps)).rejects.toMatchObject({
      code: 'oauth_verification_failed',
    });
  });

  it('rejects with oauth_verification_failed when the Google verifier throws', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.reject(new Error('exp failed'))),
    };
    const { deps } = makeDeps({ oauthVerifier: verifier });

    await expect(loginWithGoogle('eyJ.bad.token', deps)).rejects.toMatchObject({
      code: 'oauth_verification_failed',
    });
  });

  it('issues a Session on successful Apple verification', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.resolve({ sub: 'apple|sub123', email: 'alice@example.com' })),
    };
    const { deps, repo, publishEvent } = makeDeps({ oauthVerifier: verifier });
    repo.findOrCreateOAuthUser.mockResolvedValue(makeUserRow());

    const session = await loginWithApple('eyJ.good.token', deps);
    expect(session.user.id).toBe(USER_ID);
    expect(repo.findOrCreateOAuthUser).toHaveBeenCalledWith(
      'apple',
      'apple|sub123',
      'alice@example.com',
      undefined,
    );
    // Sign-in is not "registered"; no event is emitted by the service.
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('rejects with invalid_credentials when the linked user is soft-deleted', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.resolve({ sub: 'google|sub123', email: 'alice@example.com' })),
    };
    const { deps, repo } = makeDeps({ oauthVerifier: verifier });
    repo.findOrCreateOAuthUser.mockResolvedValue(makeUserRow({ deletedAt: new Date() }));

    await expect(loginWithGoogle('eyJ.good.token', deps)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('raises the underlying AuthError when the repo rejects OAuth link (e.g. missing studio)', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.resolve({ sub: 'google|sub123', email: 'alice@example.com' })),
    };
    const { deps, repo } = makeDeps({ oauthVerifier: verifier });
    repo.findOrCreateOAuthUser.mockRejectedValue(new AuthError('studio_not_found'));

    await expect(loginWithGoogle('eyJ.good.token', deps)).rejects.toMatchObject({
      code: 'studio_not_found',
    });
  });

  it('verifies the provider ID token BEFORE linking the local account (Req 1.4)', async () => {
    // Both Apple and Google must validate the JWKS signature
    // BEFORE any account creation / linking. We enforce the
    // ordering by capturing the call timestamps on two ordered
    // `vi.fn()` mocks and asserting `verify` was called first.
    const callLog: string[] = [];
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => {
        callLog.push('verify');
        return Promise.resolve({
          sub: 'apple|sub123',
          email: 'alice@example.com',
        });
      }),
    };
    const { deps, repo } = makeDeps({ oauthVerifier: verifier });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    repo.findOrCreateOAuthUser.mockImplementation(() => {
      callLog.push('findOrCreateOAuthUser');
      return Promise.resolve(makeUserRow());
    });

    await loginWithApple('eyJ.good.token', deps);

    expect(callLog).toEqual(['verify', 'findOrCreateOAuthUser']);
    expect(verifier.verify).toHaveBeenCalledWith('eyJ.good.token', 'apple');
  });

  it('does NOT link the account when the provider ID token signature is invalid (Req 1.4)', async () => {
    const verifier: OAuthVerifier = {
      verify: vi.fn(() => Promise.reject(new Error('JWSSignatureVerificationFailed'))),
    };
    const { deps, repo } = makeDeps({ oauthVerifier: verifier });

    await expect(loginWithApple('eyJ.forged.token', deps)).rejects.toMatchObject({
      code: 'oauth_verification_failed',
    });
    expect(repo.findOrCreateOAuthUser).not.toHaveBeenCalled();
  });
});
