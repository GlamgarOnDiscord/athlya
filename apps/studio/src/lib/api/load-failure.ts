/**
 * What a page shows when its main read failed: a 403 and a 404 each get
 * their own honest message, anything else the generic error with a retry.
 */
import { ApiError } from './client';

export type LoadFailure = 'forbidden' | 'notFound' | 'error';

export function loadFailure(err: unknown): LoadFailure {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'forbidden';
    if (err.status === 404) return 'notFound';
  }
  return 'error';
}

/** The problem `code` of a refused request, or the status for a rate limit. */
export function failureCode(err: unknown): string | undefined {
  if (err instanceof ApiError) return err.problem?.code;
  if (err instanceof Error && (err as Error & { status?: number }).status === 429) {
    return 'rate_limited';
  }
  return undefined;
}
