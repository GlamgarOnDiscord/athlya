import type { ProblemDetails } from '@athlya/shared/schemas/problem';

/**
 * The request never produced an HTTP response: offline, DNS or TLS
 * failure, connection reset, or the client-side timeout fired. The server
 * may or may not have received it, so a retry must reuse the same
 * `Idempotency-Key`.
 */
export class NetworkError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/**
 * The API still answered 401 after one refresh attempt, or no session can
 * be refreshed (no stored refresh token, biometric unlock declined,
 * refresh token rejected). The user has to sign in again.
 */
export class AuthRequiredError extends Error {
  public constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Non-2xx HTTP response surfaced by the typed helpers (`get`, `post`, …). */
export class ApiError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(status: number, problem?: ProblemDetails) {
    super(problem?.title ?? `HTTP ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}
