/**
 * QR check-in token for the check-in screen — task 11.9, Requirement 11.1.
 *
 * The token is a single-use RS256 JWT that lives 120 s, issued by
 * `POST /v1/checkins/token` (signing needs the server key). This
 * controller fetches one, exposes a countdown, and fetches the next one
 * shortly before `expiresAt`, but only while the screen is active: the
 * screen calls `start()` when it gains focus in the foreground and
 * `stop()` when it loses either.
 *
 * The request is never queued offline: a token minted later would be
 * useless, and the queue would replay it after it expired. Offline, a
 * token that is still valid stays on screen (the kiosk is online and can
 * still scan it); once it expires the screen says a connection is needed
 * and fetches a new one as soon as the device is back online.
 */
import { CheckInTokenResponseSchema } from '@athlya/shared/schemas/api';

import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';

import type { ApiClient } from '../../infrastructure/api/client';

export const CHECKIN_TOKEN_PATH = '/v1/checkins/token';

/** Fetch the next token this long before the current one expires. */
export const REFRESH_MARGIN_MS = 15_000;
/** Retry delay after a network failure. */
export const NETWORK_RETRY_MS = 10_000;
/** Retry delay after a 429: the token budget is per minute. */
export const RATE_LIMIT_RETRY_MS = 60_000;

export type CheckinTokenStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'error';

export interface CheckinTokenState {
  readonly status: CheckinTokenStatus;
  /** The token to render, or null when there is no valid one. */
  readonly token: string | null;
  /** Expiry of `token`, in Unix ms. */
  readonly expiresAt: number | null;
  /** Whole seconds until `expiresAt` (0 without a token). */
  readonly secondsLeft: number;
  readonly error: ErrorModel | null;
}

export const INITIAL_CHECKIN_TOKEN_STATE: CheckinTokenState = {
  status: 'idle',
  token: null,
  expiresAt: null,
  secondsLeft: 0,
  error: null,
};

export interface CheckinTokenDeps {
  readonly api: Pick<ApiClient, 'post'>;
  readonly isOnline: () => boolean;
  /** Unix ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class CheckinTokenController {
  readonly #api: Pick<ApiClient, 'post'>;
  readonly #isOnline: () => boolean;
  readonly #now: () => number;
  readonly #store = new Store<CheckinTokenState>(INITIAL_CHECKIN_TOKEN_STATE);
  #active = false;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #inflight: AbortController | null = null;

  public constructor(deps: CheckinTokenDeps) {
    this.#api = deps.api;
    this.#isOnline = deps.isOnline;
    this.#now = deps.now ?? Date.now;
  }

  public readonly get = (): CheckinTokenState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** The screen is visible: show a valid token, fetching one when needed. */
  public start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#tickTimer = setInterval(() => {
      this.#tick();
    }, 1_000);
    this.#tick();
    if (this.get().status === 'error' && this.get().error?.authRequired === true) return;
    this.#refreshNowOrLater();
  }

  /** The screen is hidden or the app went to the background: no timer, no request. */
  public stop(): void {
    this.#active = false;
    this.#clearRefresh();
    if (this.#tickTimer !== null) clearInterval(this.#tickTimer);
    this.#tickTimer = null;
    this.#inflight?.abort();
    this.#inflight = null;
    if (this.get().status === 'loading') {
      this.#store.set((state) => ({ ...state, status: state.token === null ? 'idle' : 'ready' }));
    }
  }

  /** Connectivity changed; back online, a missing or expiring token is fetched again. */
  public setOnline(online: boolean): void {
    if (!this.#active) return;
    if (!online) {
      if (this.get().token === null && this.get().status !== 'error') {
        this.#store.set((state) => ({ ...state, status: 'offline' }));
      }
      return;
    }
    if (this.get().status === 'offline' || this.get().error?.key === 'errors.network') {
      this.#clearRefresh();
      void this.#fetch();
    }
  }

  /** The user asked for a new code (retry after an error). */
  public retry(): void {
    if (!this.#active) return;
    this.#clearRefresh();
    void this.#fetch();
  }

  #refreshNowOrLater(): void {
    const { expiresAt, token } = this.get();
    const remaining = expiresAt === null || token === null ? 0 : expiresAt - this.#now();
    if (remaining > REFRESH_MARGIN_MS) {
      this.#schedule(remaining - REFRESH_MARGIN_MS);
      return;
    }
    void this.#fetch();
  }

  #schedule(delayMs: number): void {
    this.#clearRefresh();
    if (!this.#active) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#fetch();
    }, delayMs);
  }

  #clearRefresh(): void {
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  /** Recompute the countdown and drop a token that has expired. */
  #tick(): void {
    const { expiresAt, token, secondsLeft } = this.get();
    if (token === null || expiresAt === null) return;
    const left = Math.max(0, Math.ceil((expiresAt - this.#now()) / 1_000));
    if (left === 0) {
      this.#store.set((state) => ({
        ...state,
        token: null,
        expiresAt: null,
        secondsLeft: 0,
        status: state.status === 'ready' ? (this.#isOnline() ? 'idle' : 'offline') : state.status,
      }));
      return;
    }
    if (left !== secondsLeft) this.#store.set((state) => ({ ...state, secondsLeft: left }));
  }

  async #fetch(): Promise<void> {
    if (!this.#active || this.#inflight !== null) return;
    if (!this.#isOnline()) {
      if (this.get().token === null) {
        this.#store.set((state) => ({ ...state, status: 'offline', error: null }));
      }
      return;
    }
    const abort = new AbortController();
    this.#inflight = abort;
    this.#store.set((state) => ({ ...state, status: 'loading', error: null }));
    try {
      const raw = await this.#api.post<unknown>(CHECKIN_TOKEN_PATH, {}, { signal: abort.signal });
      const issued = CheckInTokenResponseSchema.parse(raw);
      if (abort.signal.aborted) return;
      const expiresAt = Date.parse(issued.expiresAt);
      this.#store.set({
        status: 'ready',
        token: issued.token,
        expiresAt,
        secondsLeft: Math.max(0, Math.ceil((expiresAt - this.#now()) / 1_000)),
        error: null,
      });
      this.#schedule(Math.max(0, expiresAt - this.#now() - REFRESH_MARGIN_MS));
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error)) return;
      this.#store.set((state) => ({
        ...state,
        status: state.token === null ? 'error' : 'ready',
        error: toErrorModel(error),
      }));
      if (error instanceof AuthRequiredError) return;
      if (error instanceof NetworkError) this.#schedule(NETWORK_RETRY_MS);
      else if (error instanceof ApiError && error.status === 429) {
        this.#schedule(RATE_LIMIT_RETRY_MS);
      }
    } finally {
      if (this.#inflight === abort) this.#inflight = null;
    }
  }
}
