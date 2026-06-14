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
 *        d) **Half-open jitter (issue #140 / audit R1).** To blunt
 *           the synchronised-probe edge of (2), each trip draws a
 *           random `resetJitterMs` (default 20 % of
 *           `resetTimeoutMs`) added to the half-open deadline. N
 *           isolates that tripped together now probe spread over
 *           `[reset, reset + jitter)` instead of all at `reset`,
 *           cutting the peak probe rate against a dead downstream
 *           with zero shared state and zero hot-path latency.
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
/*  Distributed store interface (issue #231)                          */
/* ------------------------------------------------------------------ */

/**
 * Optional shared-state back-end for {@link CircuitBreaker}.
 *
 * When provided, the breaker uses this store as the source of truth for
 * state across all isolates. All methods are async and must never throw —
 * if the back-end is unavailable the caller swallows the error and falls
 * back to the in-memory state machine (graceful degradation, H3 §4).
 *
 * The concrete implementation lives in
 * `src/adapters/circuit-breaker-redis-store.ts`.
 */
export interface CircuitBreakerStore {
  /**
   * Read current circuit state from shared storage.
   *
   * Implementation hint: store `open_until` as a millisecond timestamp.
   *   - Absent     → `'closed'`
   *   - value > now → `'open'`
   *   - value ≤ now → `'half_open'`
   */
  getState(now: number): Promise<CircuitState>;

  /**
   * Atomically record a failure and return `true` when the circuit tripped
   * to `open`. When `true` is returned, the store has already persisted the
   * `open_until` timestamp (`now + resetTimeoutMs`).
   */
  recordFailure(
    now: number,
    windowMs: number,
    failureThreshold: number,
    resetTimeoutMs: number,
  ): Promise<boolean>;

  /** Clear failure history (called on success). */
  recordSuccess(): Promise<void>;

  /**
   * Set the circuit to `open` directly (called after a failed half-open
   * probe). `openUntil` is the absolute millisecond timestamp.
   */
  recordOpen(openUntil: number): Promise<void>;

  /**
   * Acquire the half-open probe slot via a NX lock.
   * Returns `true` when this caller wins and should run the probe.
   * `ttlMs` bounds how long the lock is held before auto-expiry.
   */
  tryAcquireProbe(ttlMs: number): Promise<boolean>;

  /** Release the probe lock unconditionally (after probe completes). */
  releaseProbe(): Promise<void>;
}

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
  /**
   * Maximum extra random delay (ms) added on top of `resetTimeoutMs`
   * before an open breaker becomes half-open. Default = 20 % of
   * `resetTimeoutMs`.
   *
   * Issue #140 (audit R1): the breaker is per-isolate, so under a
   * downstream outage every warm isolate that tripped at roughly the
   * same instant would otherwise fire its half-open probe at the SAME
   * `openedAt + resetTimeoutMs` deadline — a synchronised
   * connection-storm against a service that is likely still dead. A
   * per-trip random jitter de-synchronises probes across the fleet at
   * **zero hot-path cost** (no shared state, no Redis RTT), spreading
   * them over `[resetTimeoutMs, resetTimeoutMs + resetJitterMs)`.
   *
   * Set to `0` to disable (restores the exact-deadline behaviour).
   */
  readonly resetJitterMs?: number;
  /** Monotonic clock. Default `Date.now`. Injected by tests. */
  readonly clock?: () => number;
  /**
   * Random source in `[0, 1)`. Default `Math.random`. Injected by
   * tests to make the jitter deterministic (e.g. `() => 0`).
   */
  readonly random?: () => number;
  /**
   * Optional observability hook fired on every state change (issue
   * #140 acceptance criterion: "métrique breaker state transitions").
   * Call sites pass a structured-log emitter; the breaker itself stays
   * framework-free. Synchronous and best-effort — exceptions thrown by
   * the hook are swallowed so a logging failure can never escalate a
   * downstream outage. Not invoked on construction.
   */
  readonly onTransition?: (event: CircuitTransition) => void;
  /**
   * Optional shared-state back-end (issue #231).
   *
   * When provided, `exec()` reads and writes circuit state through this
   * store so that failures accumulate fleet-wide and only one isolate
   * probes in half-open. If the store throws, the breaker silently
   * falls back to the current in-memory state machine — graceful
   * degradation is the contract.
   *
   * The Upstash Redis implementation is in
   * `src/adapters/circuit-breaker-redis-store.ts`.
   */
  readonly store?: CircuitBreakerStore;
}

/** Payload handed to {@link CircuitBreakerOptions.onTransition}. */
export interface CircuitTransition {
  readonly name: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  /** `clock()` value at the moment of the transition. */
  readonly at: number;
  /**
   * Half-open jitter (ms) for the current outage window. Carries the
   * drawn value on `* → open` (jitter chosen for the upcoming probe
   * delay) and on the matching `open → half_open` promotion (the
   * jitter actually waited out — chart it for realized probe spread).
   * `0` on `half_open → closed`: no outage window is in flight, so the
   * persisted `this.jitterMs` would be stale.
   */
  readonly jitterMs: number;
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
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/** Numeric rank so we can compare "how open" two states are. */
function stateRank(s: CircuitState): number {
  if (s === 'open') return 2;
  if (s === 'half_open') return 1;
  return 0;
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
/** Default jitter fraction of `resetTimeoutMs` (issue #140 — anti-storm). */
const DEFAULT_RESET_JITTER_FRACTION = 0.2;

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
  private readonly resetJitterMs: number;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly onTransition: ((event: CircuitTransition) => void) | undefined;
  private readonly _store: CircuitBreakerStore | undefined;

  /** Current state label. See {@link CircuitState}. */
  private _state: CircuitState = 'closed';

  /** Failure timestamps, oldest first. Filtered lazily on each touch. */
  private failures: number[] = [];

  /** Timestamp the breaker last flipped to `open`. Only valid while open. */
  private openedAt = 0;

  /**
   * Per-trip random jitter (ms) added to `resetTimeoutMs` before the
   * open → half-open promotion. Recomputed on every `tripOpen` so each
   * outage window gets a fresh, independent spread (issue #140).
   */
  private jitterMs = 0;

  /** True while a half-open probe is pending. Blocks concurrent probes. */
  private probeInFlight = false;

  constructor(opts: CircuitBreakerOptions) {
    this._name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.resetJitterMs =
      opts.resetJitterMs ?? Math.floor(this.resetTimeoutMs * DEFAULT_RESET_JITTER_FRACTION);
    this.clock = opts.clock ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.onTransition = opts.onTransition;
    this._store = opts.store;

    if (this.failureThreshold < 1) {
      throw new RangeError(`failureThreshold must be >= 1 (got ${String(this.failureThreshold)})`);
    }
    if (this.windowMs < 1) {
      throw new RangeError(`windowMs must be >= 1 (got ${String(this.windowMs)})`);
    }
    if (this.resetTimeoutMs < 1) {
      throw new RangeError(`resetTimeoutMs must be >= 1 (got ${String(this.resetTimeoutMs)})`);
    }
    if (this.resetJitterMs < 0) {
      throw new RangeError(`resetJitterMs must be >= 0 (got ${String(this.resetJitterMs)})`);
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
   *
   * When a {@link CircuitBreakerStore} is configured (issue #231),
   * state is read from and written to the store so that failures
   * accumulate fleet-wide. Store errors are swallowed and the breaker
   * falls back to the local in-memory state machine.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.clock();

    // ---- Determine effective state (store → local fallback) ----
    let effectiveState: CircuitState;
    if (this._store !== undefined) {
      try {
        effectiveState = await this._store.getState(now);
        // Advance local state when the store says we are more-open.
        if (stateRank(effectiveState) > stateRank(this._state)) {
          this._state = effectiveState;
          if (effectiveState === 'open') this.openedAt = now;
        }
      } catch {
        // Store unavailable — fall back to in-memory state machine.
        this.maybeTransitionFromOpen();
        effectiveState = this._state;
      }
    } else {
      this.maybeTransitionFromOpen();
      effectiveState = this._state;
    }

    if (effectiveState === 'open') {
      throw new CircuitOpenError(this._name);
    }

    // ---- Half-open probe path ----
    if (effectiveState === 'half_open') {
      let probeWon = false;
      if (this._store !== undefined) {
        try {
          probeWon = await this._store.tryAcquireProbe(this.resetTimeoutMs);
        } catch {
          // Store unavailable — fall back to local probe flag.
          if (this.probeInFlight) throw new CircuitOpenError(this._name);
          probeWon = true;
          this.probeInFlight = true;
        }
      } else {
        if (this.probeInFlight) throw new CircuitOpenError(this._name);
        probeWon = true;
        this.probeInFlight = true;
      }

      if (!probeWon) throw new CircuitOpenError(this._name);

      try {
        const result = await fn();
        // Probe succeeded: clear distributed state, then advance local.
        if (this._store !== undefined) {
          try {
            await this._store.recordSuccess();
            await this._store.releaseProbe();
          } catch {
            /* swallow — local update still happens */
          }
        }
        this.onProbeSuccess();
        return result;
      } catch (err) {
        // Probe failed: re-open circuit in the store, then locally.
        const openUntil = now + this.resetTimeoutMs;
        if (this._store !== undefined) {
          try {
            await this._store.recordOpen(openUntil);
            await this._store.releaseProbe();
          } catch {
            /* swallow */
          }
        }
        this.onProbeFailure();
        throw err;
      }
    }

    // ---- Closed path ----
    try {
      const result = await fn();
      if (this._store !== undefined) {
        try {
          await this._store.recordSuccess();
        } catch {
          /* swallow */
        }
      }
      this.recordSuccess();
      return result;
    } catch (err) {
      let trippedByStore = false;
      if (this._store !== undefined) {
        try {
          trippedByStore = await this._store.recordFailure(
            now,
            this.windowMs,
            this.failureThreshold,
            this.resetTimeoutMs,
          );
        } catch {
          /* swallow — local tracking still updates */
        }
      }
      // Always update local state so in-memory fallback stays consistent.
      this.recordFailure();
      // If the store tripped the circuit but local threshold hasn't been
      // reached yet, force-trip locally to stay in sync with peers.
      if (trippedByStore && this._state !== 'open') {
        this.tripOpen(now);
      }
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

  /**
   * Fire the observability hook for `from → to`. Best-effort: a hook
   * that throws must never turn a dependency blip into a 500, so the
   * error is swallowed (the breaker has no logger of its own to report
   * it to without re-coupling to the framework).
   */
  private emitTransition(from: CircuitState, to: CircuitState, at: number, jitterMs: number): void {
    if (this.onTransition === undefined) return;
    try {
      this.onTransition({ name: this._name, from, to, at, jitterMs });
    } catch {
      /* swallowed — see doc above */
    }
  }

  /** Drop failure timestamps that fell out of the sliding window. */
  private pruneFailures(now: number): void {
    const cutoff = now - this.windowMs;
    // Most of the time we drop a short prefix; a while-loop beats
    // `filter` on the hot path and preserves array identity.
    while (this.failures.length > 0 && this.failures[0]! <= cutoff) {
      this.failures.shift();
    }
  }

  /**
   * Check the reset window (+ per-trip jitter) and promote
   * `open` → `half_open`. The jitter de-synchronises probes across
   * isolates so a dead downstream is not hit by every warm isolate at
   * the same instant (issue #140).
   */
  private maybeTransitionFromOpen(): void {
    if (this._state !== 'open') return;
    const now = this.clock();
    if (now - this.openedAt >= this.resetTimeoutMs + this.jitterMs) {
      this._state = 'half_open';
      this.probeInFlight = false;
      // Surface the jitter actually waited out for this window.
      this.emitTransition('open', 'half_open', now, this.jitterMs);
    }
  }

  /** Trip `closed`/`half_open` → `open`. Draws a fresh half-open jitter. */
  private tripOpen(now: number): void {
    const from = this._state;
    this._state = 'open';
    this.openedAt = now;
    this.failures = [];
    this.probeInFlight = false;
    // Fresh jitter per outage window. `random()` ∈ [0, 1) → jitter ∈
    // [0, resetJitterMs). Clamped defensively in case an injected
    // random source returns out of range.
    this.jitterMs =
      this.resetJitterMs > 0
        ? Math.min(this.resetJitterMs, Math.max(0, Math.floor(this.random() * this.resetJitterMs)))
        : 0;
    this.emitTransition(from, 'open', now, this.jitterMs);
  }

  /** Promote `half_open` → `closed` after a successful probe. */
  private onProbeSuccess(): void {
    this._state = 'closed';
    this.failures = [];
    this.probeInFlight = false;
    // No outage window in flight — persisted jitter is stale, report 0.
    this.emitTransition('half_open', 'closed', this.clock(), 0);
  }

  /** Demote `half_open` → `open` after a failed probe. */
  private onProbeFailure(): void {
    this.tripOpen(this.clock());
  }
}
