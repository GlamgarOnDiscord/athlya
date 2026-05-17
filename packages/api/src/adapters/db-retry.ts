/**
 * Shared transient-connection retry helper for every Drizzle-backed
 * adapter in `packages/api/src/adapters/`.
 *
 * The Neon free tier suspends its compute after 5 min of inactivity;
 * the first query to wake it up frequently surfaces as a cryptic
 * "Failed query ... connection terminated" (the driver already
 * obtained a socket from its pool, but the remote side closed it
 * during the suspension). Retrying exactly once covers that window
 * without inflating a genuine outage into a storm of doomed calls.
 *
 * We match on:
 *   - Node-level `code` strings (`ECONNRESET`, `ECONNREFUSED`,
 *     `ETIMEDOUT`, `CONNECTION_ENDED`, `CONNECTION_DESTROYED`,
 *     `CONNECTION_CLOSED`).
 *   - Postgres SQLSTATE codes for admin / crash / cannot-connect
 *     shutdowns (`57P01`, `57P02`, `57P03`).
 *   - Substrings of the error message that cover what `postgres.js`
 *     wraps around its internal errors ("connection terminated",
 *     "connection closed", "connection ended", "socket hang up").
 *
 * Extracted here (rather than duplicated per adapter) so one place
 * owns the heuristic — future adapters just import the helper and
 * wrap their query calls without repeating the detection table.
 */

/**
 * Retry `fn` exactly once when the underlying TCP connection was
 * silently closed by the server. Any other failure propagates
 * unchanged so a genuine bug never gets papered over by retry
 * amplification.
 */
export async function withConnectionRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientConnectionError(err)) {
      throw err;
    }
    // Brief backoff before the retry — Neon wakes in < 500 ms on
    // a warm resume; longer delays would just inflate latency on
    // the dev free tier.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    return fn();
  }
}

function isTransientConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const withCode = err as { code?: unknown; message?: unknown };
  const code = typeof withCode.code === 'string' ? withCode.code : '';
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    code === 'CONNECTION_CLOSED' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03'
  ) {
    return true;
  }
  const msg = typeof withCode.message === 'string' ? withCode.message.toLowerCase() : '';
  return (
    msg.includes('connection terminated') ||
    msg.includes('connection closed') ||
    msg.includes('connection ended') ||
    msg.includes('socket hang up')
  );
}
