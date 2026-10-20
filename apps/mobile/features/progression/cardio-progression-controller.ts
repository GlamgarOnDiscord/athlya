/**
 * Cardio progression (issue #683, mobile).
 * Renders `GET /v1/me/progression/cardio?window=30|90|365&bucket=day|week`.
 *
 * Same caching as `ProgressionController`: the last body of each window
 * and bucket is kept in memory, revalidated with `If-None-Match` on every
 * load and reused on `304`. The endpoint is newer than
 * `/v1/me/progression`, so a `404` from a Worker that predates it puts
 * the section in the `unavailable` state instead of an error.
 */
import {
  CardioProgressionResponseSchema,
  type CardioMachineProgression,
  type CardioProgressionBucket,
  type CardioProgressionMachine,
  type CardioProgressionResponse,
  type ProgressionWindow,
} from '@athlya/shared/schemas/api';

import { parseProblem } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';

import { DEFAULT_WINDOW } from './progression-controller';

import type { ApiClient } from '../../infrastructure/api/client';

/** Bucket choices, in the order the screen offers them. */
export const CARDIO_BUCKETS: readonly CardioProgressionBucket[] = ['week', 'day'];

/** The grouping the section opens on: the API default. */
export const DEFAULT_BUCKET: CardioProgressionBucket = 'week';

export function cardioProgressionPath(
  windowDays: ProgressionWindow,
  bucket: CardioProgressionBucket,
): string {
  return `/v1/me/progression/cardio?window=${String(windowDays)}&bucket=${bucket}`;
}

/** The machine to chart: the one picked, else the first one listed. */
export function selectedMachine(
  data: CardioProgressionResponse,
  machine: CardioProgressionMachine | null,
): CardioMachineProgression | undefined {
  return data.machines.find((item) => item.machine === machine) ?? data.machines[0];
}

export interface CardioProgressionState {
  readonly load: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly windowDays: ProgressionWindow;
  readonly bucket: CardioProgressionBucket;
  /** The last body received for `windowDays` and `bucket`, kept while it is revalidated. */
  readonly data: CardioProgressionResponse | null;
  /** The machine picked by the member; `null` charts the first one. */
  readonly machine: CardioProgressionMachine | null;
  readonly error: ErrorModel | null;
}

/** What the cardio section shows for a state. */
export type CardioSectionView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly error: ErrorModel }
  | { readonly kind: 'empty'; readonly data: CardioProgressionResponse }
  | {
      readonly kind: 'data';
      readonly data: CardioProgressionResponse;
      readonly machine: CardioMachineProgression;
      /** A failed revalidation: the last body stays on screen under the error. */
      readonly error: ErrorModel | null;
    };

export function cardioSectionView(state: CardioProgressionState): CardioSectionView {
  if (state.load === 'unavailable') return { kind: 'unavailable' };
  const { data } = state;
  if (data === null) {
    return state.error === null ? { kind: 'loading' } : { kind: 'error', error: state.error };
  }
  const machine = selectedMachine(data, state.machine);
  if (machine === undefined) {
    return state.error === null ? { kind: 'empty', data } : { kind: 'error', error: state.error };
  }
  return { kind: 'data', data, machine, error: state.error };
}

interface CachedBody {
  readonly etag: string;
  readonly data: CardioProgressionResponse;
}

function cacheKey(windowDays: ProgressionWindow, bucket: CardioProgressionBucket): string {
  return `${String(windowDays)}:${bucket}`;
}

export class CardioProgressionController {
  readonly #api: Pick<ApiClient, 'send'>;
  readonly #store: Store<CardioProgressionState>;
  readonly #cache = new Map<string, CachedBody>();
  #generation = 0;
  #inflight: AbortController | null = null;

  public constructor(api: Pick<ApiClient, 'send'>, windowDays: ProgressionWindow = DEFAULT_WINDOW) {
    this.#api = api;
    this.#store = new Store<CardioProgressionState>({
      load: 'idle',
      windowDays,
      bucket: DEFAULT_BUCKET,
      data: null,
      machine: null,
      error: null,
    });
  }

  public readonly get = (): CardioProgressionState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Switches the window, showing its cached body (if any) while it reloads. */
  public selectWindow(windowDays: ProgressionWindow, signal?: AbortSignal): Promise<void> {
    return this.#select(windowDays, this.#store.get().bucket, signal);
  }

  /** Switches between daily and weekly buckets, then reloads. */
  public selectBucket(bucket: CardioProgressionBucket, signal?: AbortSignal): Promise<void> {
    return this.#select(this.#store.get().windowDays, bucket, signal);
  }

  public selectMachine(machine: CardioProgressionMachine): void {
    this.#store.set((state) => ({ ...state, machine }));
  }

  /** Cancels the load in flight, whichever started it (the screen unmounts). */
  public cancel(): void {
    this.#generation += 1;
    this.#inflight?.abort();
    this.#inflight = null;
  }

  /**
   * Loads the current window and bucket. A newer load, or `signal`,
   * cancels the one in flight; a cancelled or superseded load never
   * touches the state.
   */
  public async load(signal?: AbortSignal): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#inflight?.abort();
    const request = new AbortController();
    this.#inflight = request;
    const forwardAbort = (): void => {
      request.abort();
    };
    if (signal?.aborted === true) request.abort();
    signal?.addEventListener('abort', forwardAbort);

    const { windowDays, bucket } = this.#store.get();
    const key = cacheKey(windowDays, bucket);
    const cached = this.#cache.get(key);
    this.#store.set((state) => ({
      ...state,
      load: 'loading',
      error: null,
    }));
    try {
      const response = await this.#api.send(
        'GET',
        cardioProgressionPath(windowDays, bucket),
        undefined,
        {
          signal: request.signal,
          ...(cached === undefined ? {} : { headers: { 'If-None-Match': cached.etag } }),
        },
      );
      if (generation !== this.#generation || request.signal.aborted) return;
      const data = this.#read(key, windowDays, bucket, cached, response);
      this.#store.set((state) => ({ ...state, load: 'ready', data, error: null }));
    } catch (error) {
      if (generation !== this.#generation || request.signal.aborted || isAbortError(error)) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        this.#cache.clear();
        this.#store.set((state) => ({ ...state, load: 'unavailable', data: null, error: null }));
        return;
      }
      this.#store.set((state) => ({ ...state, load: 'error', error: toErrorModel(error) }));
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.#inflight === request) this.#inflight = null;
    }
  }

  #select(
    windowDays: ProgressionWindow,
    bucket: CardioProgressionBucket,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const current = this.#store.get();
    if (windowDays !== current.windowDays || bucket !== current.bucket) {
      this.#store.set((state) => ({
        ...state,
        windowDays,
        bucket,
        data: this.#cache.get(cacheKey(windowDays, bucket))?.data ?? null,
        error: null,
      }));
    }
    return this.load(signal);
  }

  #read(
    key: string,
    windowDays: ProgressionWindow,
    bucket: CardioProgressionBucket,
    cached: CachedBody | undefined,
    response: Awaited<ReturnType<ApiClient['send']>>,
  ): CardioProgressionResponse {
    if (response.status === 304 && cached !== undefined) return cached.data;
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, parseProblem(response.body));
    }
    const data = CardioProgressionResponseSchema.parse(response.body);
    if (data.windowDays !== windowDays || data.bucket !== bucket) {
      throw new Error(
        `Asked for ${String(windowDays)} days by ${bucket}, got ${String(data.windowDays)} days by ${data.bucket}`,
      );
    }
    const etag = response.headers.get('etag');
    if (etag === null || etag === '') this.#cache.delete(key);
    else this.#cache.set(key, { etag, data });
    return data;
  }
}
