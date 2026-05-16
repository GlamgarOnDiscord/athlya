/**
 * HTTP fetch helper with retry + jittered exponential backoff +
 * per-attempt timeout for talking to external APIs (Resend, Upstash
 * REST, etc.).
 *
 * Sprint 11 / Slice 11.3 introduced the pattern on
 * `packages/auth/src/hibp.ts` for HIBP. Sprint 12 / Slice 12.1
 * generalises it: every external HTTP dependency that can fail with
 * a transient blip (5xx / 429 / network error) deserves the same
 * resilience treatment, otherwise a 200 ms Cloudflare-edge hiccup
 * surfaces as a user-visible error.
 *
 * Why a separate helper rather than `p-retry`?
 *   - Zero deps. Keeps `@athlya/api` lean.
 *   - We need the precise "retryable HTTP status" classification
 *     (5xx + 429 retry, 4xx-except-429 do not) which `p-retry` does
 *     not model directly.
 *   - The pattern is small (~80 lines).
 *
 * Pattern parity with HIBP:
 *   - Default retries = 2 (= 3 total attempts).
 *   - Default per-attempt timeout = 5000 ms (more generous than
 *     HIBP's 2 s because Resend / Upstash often answer in 100-300 ms
 *     but can spike to 2-3 s under load).
 *   - Full-jitter exponential backoff (Stripe pattern), capped at
 *     2000 ms per sleep.
 *   - Retryable: 5xx, 429, network errors.
 *   - Non-retryable: 4xx (except 429) — short-circuit immediately.
 */

/** Options accepted by {@link fetchWithRetry}. */
export interface FetchWithRetryOptions {
    /**
     * Number of additional attempts on transient failures. Default 2
     * (= 3 total attempts). Pass `0` to disable retry entirely (used
     * by tests that want to assert single-attempt failure).
     */
    readonly retries?: number;
    /**
     * Per-attempt deadline in ms. Default 5000. Implemented via
     * `AbortSignal.timeout()` so the underlying fetch is actually
     * aborted, not just abandoned.
     */
    readonly timeoutMs?: number;
    /**
     * Override `globalThis.fetch`. Tests inject a deterministic
     * `vi.fn()`. Default is the ambient global.
     */
    readonly fetch?: typeof fetch;
}

/** Default total attempts before giving up: 3. */
export const FETCH_RETRY_DEFAULT_RETRIES = 2;

/** Default per-attempt deadline in ms. */
export const FETCH_RETRY_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Thrown when the retry budget is exhausted. Carries the last
 * underlying error so callers can map the failure to the right
 * domain error (e.g. notifications consumer would let the queue
 * redeliver, password-reset transport would log without throwing).
 */
export class FetchRetryExhaustedError extends Error {
    public override readonly name = 'FetchRetryExhaustedError';
    public readonly attempts: number;

    public constructor(
        message: string,
        attempts: number,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.attempts = attempts;
    }
}

/**
 * Sleep with full jitter — `Math.random() * min(100*2^attempt, 2000)`
 * ms. Pattern Stripe / AWS use to spread thundering herds across a
 * brief upstream outage.
 *
 * Attempt indexing: `attempt = 0` is the FIRST retry (i.e. the
 * sleep that runs after the initial request failed).
 */
async function sleepWithJitter(attempt: number): Promise<void> {
    const baseMs = 100 * 2 ** attempt;
    const capMs = Math.min(baseMs, 2000);
    const jittered = Math.random() * capMs;
    await new Promise<void>((resolve) => setTimeout(resolve, jittered));
}

/**
 * Run `fetch(url, init)` with retry + jitter + per-attempt timeout.
 *
 * Returns the {@link Response} on the first attempt that produced
 * a non-retryable status (any 2xx, any 3xx, any 4xx except 429). On
 * a retryable failure (5xx, 429, network error), waits for the
 * jittered backoff and retries up to `retries` times. After the
 * budget is exhausted, throws {@link FetchRetryExhaustedError} with
 * the last underlying cause.
 *
 * The caller is responsible for reading the body — this helper does
 * not consume it (so `Response` can still be `.json()`-ed by the
 * caller).
 *
 * Note: for fetches that need a custom `signal` (e.g. user-driven
 * cancellation), pass it on `init.signal` and this helper will OR
 * it with the per-attempt timeout via `AbortSignal.any()`. Browsers
 * since 2024 and Node 20 support `AbortSignal.any`.
 */
export async function fetchWithRetry(
    url: string,
    init: RequestInit = {},
    opts: FetchWithRetryOptions = {},
): Promise<Response> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const retries = opts.retries ?? FETCH_RETRY_DEFAULT_RETRIES;
    const timeoutMs = opts.timeoutMs ?? FETCH_RETRY_DEFAULT_TIMEOUT_MS;

    if (typeof doFetch !== 'function') {
        throw new FetchRetryExhaustedError(
            'no global fetch available and no fetch injected',
            0,
        );
    }

    let lastError: unknown = new Error('no attempt made (retries < 0)');
    const totalAttempts = retries + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal: AbortSignal =
            init.signal !== null && init.signal !== undefined
                ? AbortSignal.any([init.signal, timeoutSignal])
                : timeoutSignal;

        try {
            const response = await doFetch(url, { ...init, signal });

            // Non-retryable success or client error (except 429) —
            // surface to the caller. They decide what to do with a
            // 4xx body.
            if (
                response.ok ||
                (response.status >= 300 && response.status < 400) ||
                (response.status >= 400 &&
                    response.status < 500 &&
                    response.status !== 429)
            ) {
                return response;
            }

            // 5xx or 429 — retryable. Capture the status as the
            // "last error" but do not throw yet; the loop continues
            // unless we have exhausted the budget.
            lastError = new Error(
                `fetch ${url} returned HTTP ${String(response.status)}`,
            );
        } catch (err) {
            // Network error, abort, etc. — always retryable.
            lastError = err;
        }

        if (attempt < retries) {
            await sleepWithJitter(attempt);
        }
    }

    throw new FetchRetryExhaustedError(
        `fetch ${url} failed after ${String(totalAttempts)} attempt(s): ${describeError(lastError)}`,
        totalAttempts,
        { cause: lastError },
    );
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'unknown error';
}
