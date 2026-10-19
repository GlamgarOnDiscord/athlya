/**
 * Sign-in, registration and sign-out (Requirements 1.1, 1.5, 2.1).
 *
 * After `login` / `register` the session is stored through
 * `tokenStore.saveSession({ ...session, userId: session.user.id })` and
 * `sync.refreshOwner()` points the offline drain at the new user; sign-out
 * clears the store and refreshes the owner the same way.
 */
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@athlya/shared/schemas/api';

import { toErrorModel, type ErrorModel } from '../errors';

import { TURNSTILE_TOKEN_HEADER } from './turnstile';

import type { ApiClient } from '../../infrastructure/api/client';
import type { TokenStore } from '../../infrastructure/auth/token-store';
import type { SyncController } from '../../infrastructure/sync/sync-controller';
import type { TranslationKeys } from '@athlya/shared/i18n';
import type { z } from 'zod';

export interface AuthDeps {
  readonly api: Pick<ApiClient, 'post'>;
  readonly tokenStore: Pick<
    TokenStore,
    'saveSession' | 'clear' | 'getAccessToken' | 'lock' | 'isUnlocked' | 'readRefreshToken'
  >;
  readonly sync: Pick<SyncController, 'refreshOwner' | 'syncNow'>;
}

export type FieldErrors = Readonly<Partial<Record<string, TranslationKeys>>>;

export type AuthResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly error: ErrorModel | null; readonly fieldErrors: FieldErrors };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /**
   * Token from the Turnstile WebView, sent as `cf-turnstile-token` like on
   * the web. Single-use: the screen asks for a fresh challenge after every
   * attempt.
   */
  readonly turnstileToken?: string | null;
}

export interface RegisterInput extends LoginInput {
  readonly displayName: string;
  readonly studioSlug: string;
  readonly consents: RegisterRequest['consents'];
}

const FIELD_KEYS: Readonly<Record<string, TranslationKeys>> = {
  email: 'mobile.auth.errors.email',
  password: 'mobile.auth.errors.password',
  displayName: 'mobile.auth.errors.displayName',
  studioSlug: 'mobile.auth.errors.studioSlug',
};

function fieldErrors(error: z.ZodError): FieldErrors {
  const result: Record<string, TranslationKeys> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || field in result) continue;
    result[field] = Object.hasOwn(FIELD_KEYS, field)
      ? (FIELD_KEYS[field] ?? 'errors.validation')
      : 'errors.validation';
  }
  return result;
}

async function startSession(
  deps: AuthDeps,
  path: '/v1/auth/login' | '/v1/auth/register',
  body: LoginRequest | RegisterRequest,
  turnstileToken: string | null | undefined,
  signal: AbortSignal | undefined,
): Promise<AuthResult> {
  try {
    const raw = await deps.api.post<unknown>(path, body, {
      authenticated: false,
      ...(signal === undefined ? {} : { signal }),
      ...(turnstileToken === undefined || turnstileToken === null || turnstileToken === ''
        ? {}
        : { headers: { [TURNSTILE_TOKEN_HEADER]: turnstileToken } }),
    });
    const session = SessionResponseSchema.parse(raw);
    await deps.tokenStore.saveSession({ ...session, userId: session.user.id });
    await deps.sync.refreshOwner();
    // Changes this user queued before (offline, or while signed out) go out now.
    void deps.sync.syncNow();
    return { ok: true, userId: session.user.id };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return {
      ok: false,
      error: toErrorModel(error, { 401: 'auth.errors.invalidCredentials' }),
      fieldErrors: {},
    };
  }
}

export function signIn(
  deps: AuthDeps,
  input: LoginInput,
  signal?: AbortSignal,
): Promise<AuthResult> {
  const parsed = LoginRequestSchema.safeParse({
    email: input.email.trim(),
    password: input.password,
  });
  if (!parsed.success) {
    return Promise.resolve({ ok: false, error: null, fieldErrors: fieldErrors(parsed.error) });
  }
  return startSession(deps, '/v1/auth/login', parsed.data, input.turnstileToken, signal);
}

export function register(
  deps: AuthDeps,
  input: RegisterInput,
  signal?: AbortSignal,
): Promise<AuthResult> {
  const parsed = RegisterRequestSchema.safeParse({
    email: input.email.trim(),
    password: input.password,
    displayName: input.displayName,
    studioSlug: input.studioSlug.trim().toLowerCase(),
    consents: input.consents,
  });
  if (!parsed.success) {
    return Promise.resolve({ ok: false, error: null, fieldErrors: fieldErrors(parsed.error) });
  }
  return startSession(deps, '/v1/auth/register', parsed.data, input.turnstileToken, signal);
}

/**
 * The stored refresh token when the store is already unlocked, so sign-out
 * never raises a biometric prompt; `null` otherwise or when it cannot be read.
 */
async function unlockedRefreshToken(store: AuthDeps['tokenStore']): Promise<string | null> {
  if (!store.isUnlocked()) return null;
  try {
    return await store.readRefreshToken();
  } catch {
    return null;
  }
}

/** How long sign-out waits for the server-side revocation before going on. */
export const LOGOUT_TIMEOUT_MS = 5_000;

/**
 * Revokes this device's session server-side when an access token is at
 * hand (best effort: no refresh on 401, so no biometric prompt, and a
 * bounded wait), then forgets the local session. The stored refresh token
 * names the session to revoke, so the user's other devices stay signed
 * in; it is read only when the store is already unlocked. The user's
 * queued mutations stay queued and are sent when they sign in again.
 *
 * Resolves `false` when the secure storage could not be cleared: the
 * session is then at least locked in memory (no access token, a new unlock
 * required) and the caller should tell the user.
 */
export async function signOut(deps: AuthDeps): Promise<boolean> {
  if (deps.tokenStore.getAccessToken() !== null) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, LOGOUT_TIMEOUT_MS);
    try {
      const refreshToken = await unlockedRefreshToken(deps.tokenStore);
      await deps.api.post('/v1/auth/logout', refreshToken === null ? undefined : { refreshToken }, {
        signal: controller.signal,
        refreshOnUnauthorized: false,
      });
    } catch {
      // The local session is cleared anyway; the refresh token expires on its own.
    } finally {
      clearTimeout(timer);
    }
  }
  let cleared = true;
  try {
    await deps.tokenStore.clear();
  } catch {
    cleared = false;
    deps.tokenStore.lock();
  }
  await deps.sync.refreshOwner();
  return cleared;
}
