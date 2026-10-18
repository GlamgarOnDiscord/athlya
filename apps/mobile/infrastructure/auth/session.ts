/**
 * Access-token refresh against `POST /v1/auth/refresh` (Requirement 2.2).
 *
 * Refresh tokens are single-use: the API rotates them on every exchange,
 * so concurrent 401s must share one in-flight refresh instead of racing
 * with the same token.
 */
import { SessionResponseSchema } from '@athlya/shared/schemas/api';

import { createApiClient, parseProblem } from '../api/client';
import { ApiError } from '../api/errors';

import type { TokenStore } from './token-store';

export interface SessionRefresherOptions {
  readonly baseUrl: string;
  readonly tokenStore: TokenStore;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Builds the `refreshAccessToken` hook of the API client. Resolves the new
 * access token, or `null` when the session is gone (no stored token,
 * biometric unlock declined, or the API rejected the refresh token, which
 * also clears it). Transient failures reject so callers can retry later.
 */
export function createSessionRefresher(
  options: SessionRefresherOptions,
): () => Promise<string | null> {
  const anonymous = createApiClient({
    baseUrl: options.baseUrl,
    tokens: { getAccessToken: () => null },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  let inflight: Promise<string | null> | null = null;

  async function refresh(): Promise<string | null> {
    const refreshToken = await options.tokenStore.readRefreshToken();
    if (refreshToken === null) return null;

    const response = await anonymous.send(
      'POST',
      '/v1/auth/refresh',
      { refreshToken },
      { authenticated: false },
    );
    if (response.status === 401) {
      await options.tokenStore.clear();
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, parseProblem(response.body));
    }
    const session = SessionResponseSchema.parse(response.body);
    await options.tokenStore.saveSession(session);
    return session.accessToken;
  }

  return () => {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
