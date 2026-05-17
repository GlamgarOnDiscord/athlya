/**
 * Have-I-Been-Pwned (HIBP) breached-password lookup.
 *
 * Requirement 1.2 requires rejecting any registration where the chosen
 * password appears in the HIBP database with HTTP 422 and error code
 * `password_breached`. This module is the primitive that answers the
 * question "is this password in the HIBP corpus?"; turning the answer
 * into an HTTP response is the responsibility of the Auth service
 * layer (task 3.3) so that it can also decide the **policy** when the
 * HIBP API is unavailable (fail-open vs fail-closed). We expose an
 * explicit {@link HibpUnavailableError} for that decision.
 *
 * ### K-anonymity protocol
 *
 * We never send the password (or its full hash) over the wire. Instead
 * we use the HIBP "range" endpoint with k-anonymity:
 *
 *   1. SHA-1 the UTF-8 password, upper-case the 40-hex-char digest.
 *   2. POST the first 5 characters as a path segment; the server
 *      returns every suffix in its bucket along with the number of
 *      breaches it was seen in.
 *   3. Scan the response for our 35-char suffix; if present with a
 *      count > 0 the password is breached.
 *
 * The `Add-Padding: true` request header (documented by HIBP) makes
 * the server pad every response with random fake entries to a fixed
 * size bucket — defeating a network observer who tries to infer the
 * bucket size to shrink the anonymity set.
 *
 * SHA-1 is used here purely as a 160-bit lookup key for the public
 * HIBP corpus; it is not used as a password hash (see
 * {@link hash in `./password.js`} for that). The collision resistance
 * of SHA-1 is irrelevant for this purpose.
 *
 * ### Runtime compatibility
 *
 * We rely on the Web Crypto API (`globalThis.crypto.subtle.digest`)
 * rather than Node's `node:crypto` because the same source is executed
 * on Cloudflare Workers in production and on Node 20 in tests. Node 20
 * exposes Web Crypto as a global so no polyfill is required.
 *
 * Related requirements: 1.2.
 */

/**
 * Default endpoint for the HIBP Pwned Passwords range API. Overridable
 * via the `endpoint` option of {@link isBreached} for tests and mirrors.
 */
export const HIBP_DEFAULT_ENDPOINT = 'https://api.pwnedpasswords.com/range';

/**
 * Thrown when the HIBP API cannot be contacted or returns a non-OK
 * status code. The Auth service is expected to catch this and apply a
 * policy — the design document (§Auth Service, Req 1.2) mandates
 * fail-closed: reject registration with HTTP 422 `password_breached`.
 *
 * The error carries the underlying cause so it can be logged without
 * swallowing the network stack trace.
 */
export class HibpUnavailableError extends Error {
  public override readonly name = 'HibpUnavailableError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Options accepted by {@link isBreached}.
 *
 * - `fetch` — fetch implementation to use. Defaults to the ambient
 *   `globalThis.fetch` (available on Node 20 and Workers). Tests
 *   inject a deterministic mock.
 * - `endpoint` — HIBP range endpoint. Defaults to
 *   {@link HIBP_DEFAULT_ENDPOINT}; tests use a sentinel URL.
 * - `retries` — number of additional attempts on transient failures
 *   (network error or 5xx). Defaults to `2` (= 3 total attempts).
 *   Sprint 11 / Slice 11.3 (Epic CN.6.1). Pass `0` to disable.
 * - `timeoutMs` — per-attempt deadline. Defaults to `2000` ms.
 *   `AbortSignal.timeout()` is used so the underlying fetch is
 *   actually aborted, not just abandoned. Sprint 11 / Slice 11.3
 *   (Epic CN.6.2).
 */
export interface IsBreachedOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly retries?: number;
  readonly timeoutMs?: number;
}

/**
 * Default retry budget for {@link isBreached}. Three total attempts
 * with jittered exponential backoff covers the 99.9% case of a
 * transient HIBP / Cloudflare-edge hiccup without wasting CPU-ms on
 * a hard outage.
 */
const HIBP_DEFAULT_RETRIES = 2;

/**
 * Default per-attempt timeout. HIBP's range endpoint p99 is well
 * under 500 ms; 2 s is the operational sweet spot between "give the
 * service a chance to answer" and "fail fast for the fail-closed
 * policy".
 */
const HIBP_DEFAULT_TIMEOUT_MS = 2000;

/**
 * Sleep with jittered exponential backoff. Pattern Stripe uses for
 * its idempotent retries — full jitter (`Math.random() * cap`)
 * spreads thundering herds caused by a brief HIBP outage.
 *
 * Attempt indexing: `attempt = 0` is the first retry (i.e. fired
 * after the initial request failed), so the base delay starts at
 * 100 ms and doubles to 200 ms / 400 ms / …. Capped at 2000 ms so
 * a high `retries` value can't queue a multi-second wait.
 */
async function sleepWithJitter(attempt: number): Promise<void> {
  const baseMs = 100 * 2 ** attempt;
  const capMs = Math.min(baseMs, 2000);
  const jittered = Math.random() * capMs;
  await new Promise<void>((resolve) => setTimeout(resolve, jittered));
}

/**
 * Returns `true` iff `password` appears at least once in the HIBP
 * Pwned Passwords database using k-anonymity.
 *
 * ### Preconditions
 *
 * - `password` is a string. Empty strings are permitted (HIBP has its
 *   own entry for the empty password); the service layer is expected
 *   to reject empty passwords at validation time before calling this.
 *
 * ### Postconditions
 *
 * - On success, returns `true` when the password's SHA-1 suffix is
 *   present in the response with a count strictly greater than zero,
 *   `false` otherwise.
 * - On network failure or non-OK HTTP status, throws
 *   {@link HibpUnavailableError}. The caller's policy layer decides
 *   whether to fail open or closed.
 *
 * The comparison of the 35-char suffix is case-insensitive because the
 * HIBP API has historically returned both upper-case and (rarely)
 * mixed-case suffixes across versions.
 */
export async function isBreached(password: string, opts: IsBreachedOptions = {}): Promise<boolean> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? HIBP_DEFAULT_ENDPOINT;
  const retries = opts.retries ?? HIBP_DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? HIBP_DEFAULT_TIMEOUT_MS;

  if (typeof doFetch !== 'function') {
    throw new HibpUnavailableError('no global fetch available and no fetch injected');
  }

  const digest = await sha1Hex(password);
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  // Sprint 11 / Slice 11.3 (Epic CN.6.1+CN.6.2). The fetch is
  // wrapped in a retry+timeout loop so a transient HIBP / network
  // hiccup does not flip a legitimate registration to
  // `hibp_unavailable`. Each attempt has its own
  // `AbortSignal.timeout()` so a hung connection is killed on
  // schedule rather than blocking the Worker's CPU budget.
  //
  // Failures are accumulated and the last one is rethrown so the
  // service layer logs the underlying cause rather than a generic
  // "all retries exhausted" wrapper.
  let lastError: unknown = new HibpUnavailableError('no attempt was made (retries < 0)');
  const totalAttempts = retries + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const response = await doFetch(`${endpoint}/${prefix}`, {
        method: 'GET',
        headers: {
          'Add-Padding': 'true',
          // HIBP rejects requests without a UA; use a stable,
          // honest identifier so they can rate-limit us cleanly
          // instead of globally blocking our edge.
          'User-Agent': 'athlya-auth/1 (+https://athlya.app)',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        // 4xx are not retryable (HIBP doesn't issue them in
        // practice, but surfaces them on auth-key abuse).
        // 5xx and 429 ARE retryable — fall through to the
        // backoff branch below.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new HibpUnavailableError(
            `HIBP returned HTTP ${String(response.status)} (non-retryable)`,
          );
        }
        lastError = new HibpUnavailableError(`HIBP returned HTTP ${String(response.status)}`);
      } else {
        let body: string;
        try {
          body = await response.text();
        } catch (err) {
          lastError = new HibpUnavailableError(
            `failed to read HIBP response body: ${describeError(err)}`,
            { cause: err },
          );
          if (attempt < retries) {
            await sleepWithJitter(attempt);
            continue;
          }
          throw lastError;
        }
        return hasBreachedSuffix(body, suffix);
      }
    } catch (err) {
      // Re-throw the non-retryable 4xx surfaced above without
      // consuming a retry slot.
      if (err instanceof HibpUnavailableError && err.message.endsWith('(non-retryable)')) {
        throw err;
      }
      lastError = new HibpUnavailableError(
        `network error while calling HIBP: ${describeError(err)}`,
        { cause: err },
      );
    }

    // Reached only on retryable failures. Sleep with jitter
    // unless we've exhausted the budget, in which case the loop
    // exits and the caller sees `lastError`.
    if (attempt < retries) {
      await sleepWithJitter(attempt);
    }
  }

  throw lastError;
}

/**
 * Scans a raw HIBP range response for a given suffix. Exported for
 * unit tests; not part of the public module API.
 *
 * Each line has the shape `SUFFIX:COUNT` (sometimes with a trailing
 * `\r`). A suffix with `count === 0` is one of the padded decoys
 * returned when `Add-Padding: true` is set and must not be treated as
 * a breach. Comparison is case-insensitive.
 */
export function hasBreachedSuffix(body: string, suffix: string): boolean {
  const needle = suffix.toUpperCase();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const lineSuffix = line.slice(0, colon).toUpperCase();
    if (lineSuffix !== needle) continue;
    const count = Number.parseInt(line.slice(colon + 1), 10);
    if (Number.isFinite(count) && count > 0) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * SHA-1 of a UTF-8 encoded string, returned as an upper-case hex
 * digest (40 chars). Uses Web Crypto so the same code path runs on
 * Workers and Node.
 */
async function sha1Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new HibpUnavailableError('Web Crypto subtle API not available in this runtime');
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest('SHA-1', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
