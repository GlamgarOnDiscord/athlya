/**
 * Errors of the AI coach use case (task 21.1).
 *
 * Kept in a module of its own, free of any AI SDK import, so the HTTP
 * layer can map them to statuses without loading the SDK.
 */

/**
 * Stable codes of {@link CoachError}:
 *
 *   - `consent_required`    — the member has not opted in to sharing
 *                             data with third parties (`thirdParty`).
 *   - `quota_exceeded`      — the daily quota is used up.
 *   - `quota_unavailable`   — the quota store failed; the use case
 *                             fails closed rather than calling the model.
 *   - `not_configured`      — no model provider is configured.
 *   - `upstream_failed`     — the model provider failed or timed out.
 *   - `invalid_output`      — the model answered with a payload that
 *                             does not match `CoachAdviceSchema`.
 */
export type CoachErrorCode =
  | 'consent_required'
  | 'quota_exceeded'
  | 'quota_unavailable'
  | 'not_configured'
  | 'upstream_failed'
  | 'invalid_output';

export class CoachError extends Error {
  public readonly code: CoachErrorCode;
  /** Seconds until a retry can succeed (`quota_exceeded`). */
  public readonly retryAfterSec: number | undefined;

  public constructor(
    code: CoachErrorCode,
    message: string,
    options: { readonly retryAfterSec?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CoachError';
    this.code = code;
    this.retryAfterSec = options.retryAfterSec;
  }
}

/** True when `err` is a {@link CoachError}, also across bundle copies. */
export function isCoachError(err: unknown): err is CoachError {
  return (
    err instanceof CoachError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'CoachError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}
