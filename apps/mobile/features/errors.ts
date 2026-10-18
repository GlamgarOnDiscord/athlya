/**
 * Maps the API client's errors to what a screen shows: a translated
 * message key, plus whether the user has to sign in again.
 */
import { ApiError, AuthRequiredError, NetworkError } from '../infrastructure/api/errors';

import type { TranslationKeys } from '@athlya/shared/i18n';

export interface ErrorModel {
  readonly key: TranslationKeys;
  /** The session is gone: the screen offers a way back to the sign-in screen. */
  readonly authRequired: boolean;
}

/** Problem `code`s with a dedicated message. */
const PROBLEM_CODE_KEYS: Readonly<Record<string, TranslationKeys>> = {
  class_in_past: 'errors.classInPast',
  cancellation_window_closed: 'errors.cancelWindowClosed',
  invalid_transition: 'errors.invalidTransition',
  range_too_large: 'errors.rangeTooLarge',
  password_breached: 'errors.passwordBreached',
  email_taken: 'mobile.auth.errors.emailTaken',
  studio_not_found: 'mobile.auth.errors.studioNotFound',
  bot_challenge_failed: 'mobile.auth.errors.botCheck',
  rate_limit_exceeded: 'errors.rateLimited',
};

function statusKey(status: number): TranslationKeys {
  if (status === 401) return 'errors.unauthorized';
  if (status === 403) return 'errors.forbidden';
  if (status === 404) return 'errors.notFound';
  if (status === 422 || status === 400) return 'errors.validation';
  if (status === 429) return 'errors.rateLimited';
  return 'errors.generic';
}

/**
 * `overrides` maps an HTTP status to a screen-specific message, e.g. 401 on
 * the login screen means wrong credentials, not an expired session.
 */
export function toErrorModel(
  error: unknown,
  overrides: Readonly<Partial<Record<number, TranslationKeys>>> = {},
): ErrorModel {
  if (error instanceof AuthRequiredError) {
    return { key: 'mobile.errors.sessionExpired', authRequired: true };
  }
  if (error instanceof NetworkError) return { key: 'errors.network', authRequired: false };
  if (error instanceof ApiError) {
    const override = overrides[error.status];
    if (override !== undefined) return { key: override, authRequired: false };
    const code = error.problem?.code;
    const byCode = code === undefined ? undefined : PROBLEM_CODE_KEYS[code];
    return { key: byCode ?? statusKey(error.status), authRequired: false };
  }
  return { key: 'errors.generic', authRequired: false };
}

/** True for the abort error a cancelled request rethrows (unmount, user cancel). */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { readonly name: unknown }).name === 'AbortError'
  );
}

/** The error a write cancelled before it was sent rejects with. */
export function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
