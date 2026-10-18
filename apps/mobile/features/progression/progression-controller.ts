/**
 * Progression graphs — task 22.2 (mobile), Requirements 27.1 and 27.3.
 * Renders `GET /v1/me/progression?window=30|90|365`.
 *
 * The API sends an `ETag` with every body and answers `304` to a matching
 * `If-None-Match`, so the controller keeps the last body of each window
 * in memory, revalidates it on every load and reuses it on `304`.
 */
import {
  PROGRESSION_WINDOWS,
  ProgressionResponseSchema,
  type ExerciseProgression,
  type ProgressionResponse,
  type ProgressionWindow,
} from '@athlya/shared/schemas/api';

import { parseProblem } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';

import type { ApiClient } from '../../infrastructure/api/client';

export { PROGRESSION_WINDOWS };
export type { ProgressionWindow };

/** The window the screen opens on: the API default. */
export const DEFAULT_WINDOW: ProgressionWindow = 90;

export function progressionPath(windowDays: ProgressionWindow): string {
  return `/v1/me/progression?window=${String(windowDays)}`;
}

/** The exercise to chart: the one picked, else the first (most trained). */
export function selectedExercise(
  data: ProgressionResponse,
  key: string | null,
): ExerciseProgression | undefined {
  return data.exercises.find((exercise) => exercise.key === key) ?? data.exercises[0];
}

export interface ProgressionState {
  readonly load: 'idle' | 'loading' | 'ready' | 'error';
  readonly windowDays: ProgressionWindow;
  /** The last body received for `windowDays`, kept while it is revalidated. */
  readonly data: ProgressionResponse | null;
  /** The exercise picked by the member; `null` charts the first one. */
  readonly exerciseKey: string | null;
  readonly error: ErrorModel | null;
}

interface CachedBody {
  readonly etag: string;
  readonly data: ProgressionResponse;
}

export class ProgressionController {
  readonly #api: Pick<ApiClient, 'send'>;
  readonly #store: Store<ProgressionState>;
  readonly #cache = new Map<ProgressionWindow, CachedBody>();
  #generation = 0;
  #inflight: AbortController | null = null;

  public constructor(api: Pick<ApiClient, 'send'>, windowDays: ProgressionWindow = DEFAULT_WINDOW) {
    this.#api = api;
    this.#store = new Store<ProgressionState>({
      load: 'idle',
      windowDays,
      data: null,
      exerciseKey: null,
      error: null,
    });
  }

  public readonly get = (): ProgressionState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Switches the window, showing its cached body (if any) while it reloads. */
  public selectWindow(windowDays: ProgressionWindow, signal?: AbortSignal): Promise<void> {
    if (windowDays !== this.#store.get().windowDays) {
      this.#store.set((state) => ({
        ...state,
        windowDays,
        data: this.#cache.get(windowDays)?.data ?? null,
        error: null,
      }));
    }
    return this.load(signal);
  }

  public selectExercise(key: string): void {
    this.#store.set((state) => ({ ...state, exerciseKey: key }));
  }

  /** Cancels the load in flight, whichever started it (the screen unmounts). */
  public cancel(): void {
    this.#generation += 1;
    this.#inflight?.abort();
    this.#inflight = null;
  }

  /**
   * Loads the current window. A newer load, or `signal`, cancels the one
   * in flight; a cancelled or superseded load never touches the state.
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

    const { windowDays } = this.#store.get();
    const cached = this.#cache.get(windowDays);
    this.#store.set((state) => ({ ...state, load: 'loading', error: null }));
    try {
      const response = await this.#api.send('GET', progressionPath(windowDays), undefined, {
        signal: request.signal,
        ...(cached === undefined ? {} : { headers: { 'If-None-Match': cached.etag } }),
      });
      if (generation !== this.#generation || request.signal.aborted) return;
      const data = this.#read(windowDays, cached, response);
      this.#store.set((state) => ({ ...state, load: 'ready', data, error: null }));
    } catch (error) {
      if (generation !== this.#generation || request.signal.aborted || isAbortError(error)) {
        return;
      }
      this.#store.set((state) => ({ ...state, load: 'error', error: toErrorModel(error) }));
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.#inflight === request) this.#inflight = null;
    }
  }

  #read(
    windowDays: ProgressionWindow,
    cached: CachedBody | undefined,
    response: Awaited<ReturnType<ApiClient['send']>>,
  ): ProgressionResponse {
    if (response.status === 304 && cached !== undefined) return cached.data;
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, parseProblem(response.body));
    }
    const data = ProgressionResponseSchema.parse(response.body);
    if (data.windowDays !== windowDays) {
      throw new Error(
        `Asked for a ${String(windowDays)}-day window, got ${String(data.windowDays)}`,
      );
    }
    const etag = response.headers.get('etag');
    if (etag === null || etag === '') this.#cache.delete(windowDays);
    else this.#cache.set(windowDays, { etag, data });
    return data;
  }
}
