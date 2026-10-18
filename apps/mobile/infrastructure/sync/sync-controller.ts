/**
 * Connectivity-driven auto-drain — task 11.7, Requirement 19.3.
 *
 * Drains the mutation queue whenever the device goes from offline to
 * online (and once at start when already online), never runs two drains
 * at once, and publishes an immutable `SyncState` snapshot the UI renders
 * as "Syncing 32/50" (design.md edge case E8).
 */

import { drainMutationQueue, type DrainOptions, type DrainResult } from './drain';

import type { MutationQueue } from './queue';
import type { ApiClient } from '../api/client';

/** Platform connectivity, backed by NetInfo on device. */
export interface ConnectivitySource {
  isOnline(): boolean;
  /** Called with the new online flag on every connectivity change. */
  subscribe(listener: (online: boolean) => void): () => void;
}

/**
 * Online means "connected and not known to lack internet access":
 * `isInternetReachable` is `null` until NetInfo's reachability probe
 * answers, and a captive portal reports `false`.
 */
export function isOnlineState(state: {
  readonly isConnected: boolean | null;
  readonly isInternetReachable: boolean | null | undefined;
}): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'auth-required';

export interface SyncState {
  readonly status: SyncStatus;
  /** Progress of the running drain; both 0 when idle. */
  readonly total: number;
  readonly processed: number;
  readonly pending: number;
  readonly deadLetters: number;
  readonly lastResult: DrainResult | null;
}

export interface SyncControllerOptions {
  readonly queue: MutationQueue;
  readonly api: Pick<ApiClient, 'send'>;
  readonly connectivity: ConnectivitySource;
  readonly drainOptions?: Omit<DrainOptions, 'isOnline' | 'onProgress'>;
  /** Unexpected drain failures (storage errors); report them to Sentry. */
  readonly onError?: (error: unknown) => void;
}

export class SyncController {
  readonly #options: SyncControllerOptions;
  readonly #listeners = new Set<() => void>();
  #state: SyncState;
  #running: Promise<DrainResult | null> | null = null;
  #rerunRequested = false;

  public constructor(options: SyncControllerOptions) {
    this.#options = options;
    this.#state = {
      status: options.connectivity.isOnline() ? 'idle' : 'offline',
      total: 0,
      processed: 0,
      pending: options.queue.size,
      deadLetters: options.queue.deadLetters().length,
      lastResult: null,
    };
  }

  /** Starts listening; returns the function that stops it. */
  public start(): () => void {
    let wasOnline = this.#options.connectivity.isOnline();
    const stopConnectivity = this.#options.connectivity.subscribe((online) => {
      const reconnected = online && !wasOnline;
      wasOnline = online;
      if (!online) {
        if (this.#running === null) this.#update({ status: 'offline' });
        return;
      }
      if (this.#state.status === 'offline') this.#update({ status: 'idle' });
      if (reconnected) this.#fireAndForget();
    });
    const stopQueue = this.#options.queue.subscribe(() => {
      this.#update({
        pending: this.#options.queue.size,
        deadLetters: this.#options.queue.deadLetters().length,
      });
    });
    if (wasOnline) this.#fireAndForget();
    return () => {
      stopConnectivity();
      stopQueue();
    };
  }

  /**
   * Drains now when online. A call made while a drain runs is coalesced
   * into one follow-up drain, so freshly enqueued mutations are not left
   * behind. Resolves `null` when offline.
   */
  public syncNow(): Promise<DrainResult | null> {
    if (this.#running !== null) {
      this.#rerunRequested = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  public getState(): SyncState {
    return this.#state;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #loop(): Promise<DrainResult | null> {
    let result: DrainResult | null = null;
    do {
      this.#rerunRequested = false;
      if (!this.#options.connectivity.isOnline() || this.#options.queue.size === 0) break;
      this.#update({ status: 'syncing', total: this.#options.queue.size, processed: 0 });
      result = await drainMutationQueue(this.#options.queue, this.#options.api, {
        ...this.#options.drainOptions,
        isOnline: () => this.#options.connectivity.isOnline(),
        onProgress: ({ total, processed }) => {
          this.#update({ total, processed });
        },
      });
      if (result.stoppedBy !== 'completed') break;
    } while (this.#rerunRequested);

    const status =
      result?.stoppedBy === 'auth-required'
        ? 'auth-required'
        : this.#options.connectivity.isOnline()
          ? 'idle'
          : 'offline';
    this.#update({
      status,
      total: 0,
      processed: 0,
      pending: this.#options.queue.size,
      deadLetters: this.#options.queue.deadLetters().length,
      lastResult: result ?? this.#state.lastResult,
    });
    return result;
  }

  #fireAndForget(): void {
    this.syncNow().catch((error: unknown) => {
      this.#update({ status: this.#options.connectivity.isOnline() ? 'idle' : 'offline' });
      this.#options.onError?.(error);
    });
  }

  #update(patch: Partial<SyncState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
