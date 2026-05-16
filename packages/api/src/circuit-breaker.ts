/**
 * Per-dependency circuit breaker — task 8.7.
 *
 * Satisfies Requirement 24.2:
 *
 *   "WHEN a downstream service exceeds 5 consecutive failures within
 *    30 seconds, THE API_Gateway SHALL open a circuit breaker for
 *    that service and respond with HTTP 503 and `Retry-After: 2` for
 *    60 seconds before entering half-open state."
 *
 * This module owns the state machine only. Mapping an open circuit
 * into an HTTP 503 + `Retry-After: 2` envelope is the caller's
 * responsibility (done in the per-dependency adapter or in the
 * gateway's global error handler once task 8.5's Problem Details
 * middleware lands). Keeping the breaker framework-free is a
 * deliberate design choice:
 *
 *   • Adapters for Redis, Postgres, Stripe, Resend each instantiate
 *     one `CircuitBreaker` at module scope and wrap the call with
 *     `breaker.exec(() => redis.get(key))`. A Worker isolate runs
 *     single-threaded per request, so a plain in-memory `Map` of
 *     breakers outlives the request without a lock.
 *   • The breaker knows nothing about Hono, about HTTP status codes,
 *     or about the caller's retry strategy. It emits one of two
 *     outcomes: the wrapped function resolves (pass-through) or the
 *     breaker raises {@link CircuitOpenError} so the caller can map
 *     it to a 503 / fallback / degraded response as appropriate.
 *
 * State machine (design §"Circuit breaker"):
 *
 *                        failureThreshold failures
 *                        within windowMs
 *        ┌──────────┐   ───────────────────────►   ┌────────┐
 *        │  closed  │                              │  open  │
 *        │          │   ◄───────────────────────   │        │
 *        └──────────┘   probe succeeds             └────────┘
 *              ▲                                         │
 *              │                                         │ resetTimeoutMs
 *              │                                         ▼
 *              │                                    ┌────────────┐
 *              └──────── probe succeeds ─────────── │  half_open │
 *                                                   └────────────┘
 *                                                         │
 *                                                         │ probe fails
 *                                                         ▼
 *                                                      open
 *
 * In `half_open` only one probe is in flight at a time; any request
 * that arrives while the probe is pending is rejected with
 * {@link CircuitOpenError} just as if the circuit were fully open.
 * This keeps the breaker conservative: a burst of concurrent traffic
 * landing exactly when the timer elapses does not stampede the
 * downstream.
 *
 * The failure buffer uses a rolling array of timestamps and is
 * filtered lazily at every access — ring-buffer allocations would be
 * faster but the threshold is small (5) and the surface is per-
 * isolate, so the straightforward implementation is more readable and
 * plenty fast.
 *
 * The `clock` option exists so tests can drive the state machine
 * deterministically (jumping forward past `windowMs` or
 * `resetTimeoutMs` without `setTimeout` / real wall time). Production
 * callers omit it and get `Date.now()`.
 */

/* ================================================================== */
/*  Semantics under Cloudflare Workers (H3 decision)                   */
/* ================================================================== */
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  SEMANTICS UNDER CLOUDFLARE WORKERS — H3 decision                ║
 * ╠══════════════════════════════════════════════════════════════════╣
 *
 * The state of this breaker (the `failures` buffer, `openedAt`, and
 * `probeInFlight`) lives entirely **in-memory, per Worker isolate**.
 * It is not shared across isolates, not shared across colos, not
 * shared across regions. Two isolates serving traffic for the SAME
 * dependency (e.g. two isolates both calling Redis) hold two
 * completely independent breakers — a trip on one has zero effect
 * on the other.
 *
 * Consequences, stated honestly:
 *
 *   1. **Per-isolate state only.** `failures`, `openedAt`, and
 *      `probeInFlight` are instance fields on an object allocated
 *      inside one isolate. When the isolate is evicted, the state
 *      disappears with it. When a new isolate spins up, its
 *      breakers start `closed` regardless of what peer isolates
 *      are currently observing.
 *
 *   2. **Contention amplification on a dead downstream.** Under
 *      contention, a truly-dead downstream can still be hit by one
 *      probe per *live isolate* per half-open cycle, not one probe
 *      globally. If 40 isolates are warm during an outage, the
 *      dead service sees up to 40 probes every `resetTimeoutMs` —
 *      not one. This is accepted because:
 *
 *        a) Cloudflare Workers reap idle isolates within ~15 s, so
 *           the breaker's per-isolate view of "recent reality"
 *           converges quickly even across a volatile fleet.
 *
 *        b) The surrounding platform already absorbs ~90% of the
 *           "keep hitting a dead service" pressure: Cloudflare's
 *           fetch retries back off, Hyperdrive fails fast on a
 *           down Postgres, Upstash's managed Redis has its own
 *           SLA + internal protection.
 *
 *        c) The breaker's actual job is "stop hammering the
 *           service for 60 s in THIS isolate after 5 local
 *           failures". That responsibility is fully preserved
 *           per-isolate. The breaker is a **local, best-effort
 *           fuse**, not a globally-coordinated load shedder.
 *
 *   3. **Redis-backed coordination was considered and rejected.**
 *      Keeping the breaker's state in Redis would add roughly
 *      +5-10 ms per downstream call (one Redis RTT, on the probe
 *      path at minimum, and every state read on the hot path if
 *      implemented naively). That cost directly contradicts the
 *      p99 < 500 ms SLO on the reservation endpoint (Req 23.2):
 *      on an endpoint that already spends most of its budget on
 *      Postgres + business logic, we cannot afford another
 *      Redis round-trip per call just to coordinate a local fuse.
 *
 *   4. **Escape hatch for truly-expensive failure modes.** If a
 *      caller ever needs strict global coordination — e.g. a
 *      payment gateway where each failed call has real monetary
 *      or compliance cost, far exceeding the p99 budget — they
 *      should instantiate a SECOND breaker wrapping a Redis-
 *      backed policy at the call site. This module deliberately
 *      leaves that door open (the state-machine surface is
 *      `exec` + `recordSuccess` + `recordFailure`, which a Redis
 *      adapter can implement) but does NOT open it by default.
 *
 * ╚══════════════════════════════════════════════════════════════════╝
 */

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Configuration for a single {@link CircuitBreaker} instance.
 *
 * - `name` surfaces in {@link CircuitOpenError.circuitName} so logs
 *   and dashboards can pivot on the offending dependency.
 * - `failureThreshold` / `windowMs` encode Req 24.2 exactly
 *   (5 failures in 30 000 ms).
 * - `resetTimeoutMs` defaults to the 60 s grace period mandated by
 *   Req 24.2.
 * - `clock` is for tests. In production every instance shares
 *   `Date.now` so any wall-clock advance is observed by every
 *   breaker — there is no per-breaker clock state to synchronise.
 */
export interface CircuitBreakerOptions {
    /** Human-readable identifier (e.g. `'redis'`, `'postgres'`). */
    readonly name: string;
    /** Failures within `windowMs` that flip closed → open. Default 5. */
    readonly failureThreshold?: number;
    /** Rolling window size in milliseconds. Default 30 000. */
    readonly windowMs?: number;
    /** Open → half-open cool-down in milliseconds. Default 60 000. */
    readonly resetTimeoutMs?: number;
    /** Monotonic clock. Default `Date.now`. Injected by tests. */
    readonly clock?: () => number;
}

/** Public state label. Narrower strings keep caller `switch`es exhaustive. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Error raised by {@link CircuitBreaker.exec} when the breaker is
 * open (or busy on a half-open probe). Carries the circuit name so
 * the caller can log / dashboard which dependency is tripped without
 * stringifying a generic error message.
 *
 * `code = 'circuit_open'` matches the convention used by
 * `packages/api/src/ratelimit.ts` and the auth middleware: every
 * error type the gateway raises carries a short, stable machine-
 * readable code that survives localisation.
 */
export class CircuitOpenError extends Error {
    readonly circuitName: string;
    readonly code = 'circuit_open' as const;

    constructor(circuitName: string) {
        super(`circuit breaker "${circuitName}" is open`);
        this.name = 'CircuitOpenError';
        this.circuitName = circuitName;
    }
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

/** Default failure threshold (Req 24.2). */
const DEFAULT_FAILURE_THRESHOLD = 5;
/** Default sliding window for the failure buffer (Req 24.2). */
const DEFAULT_WINDOW_MS = 30_000;
/** Default open → half-open cool-down (Req 24.2). */
const DEFAULT_RESET_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Per-dependency circuit breaker. One instance per downstream; not a
 * singleton.
 *
 * Thread-safety: Cloudflare Worker isolates execute requests on a
 * single thread, so the `probeInFlight` flag is protection enough
 * against parallel probes. Running the breaker from Node (e.g. tests,
 * ad-hoc tooling) preserves the same assumption because all `exec`
 * calls enter synchronously — the first one observing `half_open`
 * flips `probeInFlight` to `true` before `await`ing `fn`, and later
 * arrivals within the same microtask queue see the flag set.
 */
export class CircuitBreaker {
    private readonly _name: string;
    private readonly failureThreshold: number;
    private readonly windowMs: number;
    private readonly resetTimeoutMs: number;
    private readonly clock: () => number;

    /** Current state label. See {@link CircuitState}. */
    private _state: CircuitState = 'closed';

    /** Failure timestamps, oldest first. Filtered lazily on each touch. */
    private failures: number[] = [];

    /** Timestamp the breaker last flipped to `open`. Only valid while open. */
    private openedAt = 0;

    /** True while a half-open probe is pending. Blocks concurrent probes. */
    private probeInFlight = false;

    constructor(opts: CircuitBreakerOptions) {
        this._name = opts.name;
        this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
        this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
        this.resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
        this.clock = opts.clock ?? Date.now;

        if (this.failureThreshold < 1) {
            throw new RangeError(
                `failureThreshold must be >= 1 (got ${String(this.failureThreshold)})`,
            );
        }
        if (this.windowMs < 1) {
            throw new RangeError(
                `windowMs must be >= 1 (got ${String(this.windowMs)})`,
            );
        }
        if (this.resetTimeoutMs < 1) {
            throw new RangeError(
                `resetTimeoutMs must be >= 1 (got ${String(this.resetTimeoutMs)})`,
            );
        }
    }

    /** Human-readable identifier — matches {@link CircuitBreakerOptions.name}. */
    get name(): string {
        return this._name;
    }

    /**
     * Current state. Calling this may flip `open → half_open` when
     * the reset timer has elapsed — the breaker advances its state
     * lazily on inspection / execution, without an internal timer.
     * That keeps the module timer-free (no `setTimeout` to clean up
     * at isolate eviction).
     */
    state(): CircuitState {
        this.maybeTransitionFromOpen();
        return this._state;
    }

    /**
     * Execute `fn` while enforcing the breaker policy.
     *
     *   - `closed`    → run `fn`; success resets the failure buffer,
     *                   failure records a new failure (possibly
     *                   tripping to `open`).
     *   - `open`      → immediately throw {@link CircuitOpenError}.
     *                   `fn` is NOT invoked. When the reset timer
     *                   has elapsed, the call is retried as a
     *                   half-open probe.
     *   - `half_open` → the first caller to arrive becomes the probe
     *                   (success → closed, failure → open). Any
     *                   concurrent call while the probe is in flight
     *                   is rejected with {@link CircuitOpenError}.
     */
    async exec<T>(fn: () => Promise<T>): Promise<T> {
        this.maybeTransitionFromOpen();

        if (this._state === 'open') {
            throw new CircuitOpenError(this._name);
        }

        if (this._state === 'half_open') {
            if (this.probeInFlight) {
                throw new CircuitOpenError(this._name);
            }
            this.probeInFlight = true;
            try {
                const result = await fn();
                this.onProbeSuccess();
                return result;
            } catch (err) {
                this.onProbeFailure();
                throw err;
            }
        }

        // Closed path.
        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (err) {
            this.recordFailure();
            throw err;
        }
    }

    /**
     * Manually record a successful call. Exposed for callers that
     * wrap `fn` with their own error handling (e.g. distinguishing
     * expected vs. unexpected errors) and want the breaker to track
     * only the latter.
     *
     * In `closed` state this clears the failure buffer — Req 24.2
     * talks about "consecutive" failures, so a single success resets
     * the counter. In `half_open` this promotes the probe. Noop in
     * `open` (callers can't call `exec` to trigger a manual success
     * because `exec` will short-circuit; calling `recordSuccess`
     * directly while open is a caller bug but we do not throw).
     */
    recordSuccess(): void {
        this.maybeTransitionFromOpen();
        if (this._state === 'closed') {
            this.failures = [];
            return;
        }
        if (this._state === 'half_open') {
            this.onProbeSuccess();
        }
    }

    /**
     * Manually record a failure. Symmetric with {@link recordSuccess}.
     * Advances the state machine just like a thrown `fn`.
     */
    recordFailure(): void {
        this.maybeTransitionFromOpen();
        if (this._state === 'half_open') {
            this.onProbeFailure();
            return;
        }
        if (this._state === 'closed') {
            const now = this.clock();
            this.pruneFailures(now);
            this.failures.push(now);
            if (this.failures.length >= this.failureThreshold) {
                this.tripOpen(now);
            }
        }
        // In `open` the failure is already reflected by the state;
        // no need to record anything.
    }

    /* ----------- internal transitions ----------- */

    /** Drop failure timestamps that fell out of the sliding window. */
    private pruneFailures(now: number): void {
        const cutoff = now - this.windowMs;
        // Most of the time we drop a short prefix; a while-loop beats
        // `filter` on the hot path and preserves array identity.
        while (this.failures.length > 0 && this.failures[0]! <= cutoff) {
            this.failures.shift();
        }
    }

    /** Check the 60 s reset window and promote `open` → `half_open`. */
    private maybeTransitionFromOpen(): void {
        if (this._state !== 'open') return;
        const now = this.clock();
        if (now - this.openedAt >= this.resetTimeoutMs) {
            this._state = 'half_open';
            this.probeInFlight = false;
        }
    }

    /** Trip `closed` → `open`. */
    private tripOpen(now: number): void {
        this._state = 'open';
        this.openedAt = now;
        this.failures = [];
        this.probeInFlight = false;
    }

    /** Promote `half_open` → `closed` after a successful probe. */
    private onProbeSuccess(): void {
        this._state = 'closed';
        this.failures = [];
        this.probeInFlight = false;
    }

    /** Demote `half_open` → `open` after a failed probe. */
    private onProbeFailure(): void {
        this.tripOpen(this.clock());
    }
}
