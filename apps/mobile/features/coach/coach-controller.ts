/**
 * AI coach — task 21.2 (mobile). Mirrors `/me/coach` on the web.
 *
 * `GET /v1/coach` decides what the screen offers: nothing while the
 * `ai-coach` flag is off for the member, a consent notice until the
 * `thirdParty` consent is granted, then the question form.
 *
 * `POST /v1/coach/ask` is streamed (`Accept: text/event-stream`, read with
 * the shared SSE parser): `partial` snapshots are provisional, replaced by
 * the validated `done` answer and dropped on an `error` event. Refusals
 * before the stream opens keep their problem statuses, and a JSON answer
 * is still accepted. Asking again or `cancel()` aborts the request in
 * flight, which aborts the provider call server-side.
 */
import { readCoachStream, type CoachStreamResult } from '@athlya/shared/coach-stream';
import {
  CoachAskResponseSchema,
  CoachStatusResponseSchema,
  type CoachAdvicePartial,
  type CoachAskRequest,
  type CoachAskResponse,
  type CoachQuota,
} from '@athlya/shared/schemas/api';

import { parseProblem } from '../../infrastructure/api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { isAbortError, toErrorModel, type ErrorModel } from '../errors';
import { Store } from '../store';

import type { ApiClient, StreamResponse } from '../../infrastructure/api/client';

export const COACH_STATUS_PATH = '/v1/coach';
export const COACH_ASK_PATH = '/v1/coach/ask';

export type CoachStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ErrorModel }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'ready'; readonly consent: boolean; readonly quota: CoachQuota };

export type CoachAsk =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly partial: CoachAdvicePartial | null }
  | { readonly kind: 'done'; readonly answer: CoachAskResponse }
  | { readonly kind: 'error'; readonly error: ErrorModel };

export interface CoachState {
  readonly status: CoachStatus;
  readonly ask: CoachAsk;
}

type CoachApi = Pick<ApiClient, 'get' | 'postStream'>;

/** True when `GET /v1/coach` reports the coach on for the member; `false` on any failure. */
export async function isCoachEnabled(
  api: Pick<ApiClient, 'get'>,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const raw = await api.get<unknown>(COACH_STATUS_PATH, signal === undefined ? {} : { signal });
    const parsed = CoachStatusResponseSchema.safeParse(raw);
    return parsed.success && parsed.data.enabled;
  } catch {
    return false;
  }
}

function unavailable(): ErrorModel {
  return { key: 'coach.errors.unavailable', authRequired: false };
}

async function readAnswer(
  response: StreamResponse,
  onPartial: (partial: CoachAdvicePartial) => void,
): Promise<CoachStreamResult> {
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(response.status, parseProblem(response.body));
  }
  if (response.stream !== null) return readCoachStream(response.stream, onPartial);
  const parsed = CoachAskResponseSchema.safeParse(response.body);
  return parsed.success
    ? { kind: 'done', answer: parsed.data }
    : { kind: 'error', problem: undefined };
}

export class CoachController {
  readonly #api: CoachApi;
  readonly #store = new Store<CoachState>({ status: { kind: 'loading' }, ask: { kind: 'idle' } });
  #statusRequest: AbortController | null = null;
  #askRequest: AbortController | null = null;

  public constructor(api: CoachApi) {
    this.#api = api;
  }

  public readonly get = (): CoachState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Aborts the status read and the question in flight (the screen unmounts). */
  public cancel(): void {
    this.#statusRequest?.abort();
    this.#statusRequest = null;
    this.#askRequest?.abort();
    this.#askRequest = null;
  }

  /** Reads `GET /v1/coach`; a newer load cancels the one in flight. */
  public async load(): Promise<void> {
    this.#statusRequest?.abort();
    const request = new AbortController();
    this.#statusRequest = request;
    this.#store.set((state) => ({ ...state, status: { kind: 'loading' } }));
    try {
      const raw = await this.#api.get<unknown>(COACH_STATUS_PATH, { signal: request.signal });
      if (request.signal.aborted) return;
      const parsed = CoachStatusResponseSchema.safeParse(raw);
      const status: CoachStatus = !parsed.success
        ? { kind: 'error', error: toErrorModel(parsed.error) }
        : parsed.data.enabled
          ? { kind: 'ready', consent: parsed.data.thirdPartyConsent, quota: parsed.data.quota }
          : { kind: 'disabled' };
      this.#store.set((state) => ({ ...state, status }));
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) return;
      this.#store.set((state) => ({
        ...state,
        status: { kind: 'error', error: toErrorModel(error) },
      }));
    } finally {
      if (this.#statusRequest === request) this.#statusRequest = null;
    }
  }

  /** Asks the coach; does nothing unless the form is offered and the question is not blank. */
  public async ask(question: string, locale: CoachAskRequest['locale']): Promise<void> {
    const { status } = this.#store.get();
    const trimmed = question.trim();
    if (status.kind !== 'ready' || !status.consent || trimmed === '') return;

    this.#askRequest?.abort();
    const request = new AbortController();
    this.#askRequest = request;
    const current = (): boolean => this.#askRequest === request && !request.signal.aborted;
    this.#setAsk({ kind: 'pending', partial: null });
    try {
      const response = await this.#api.postStream(
        COACH_ASK_PATH,
        { question: trimmed, locale },
        { signal: request.signal },
      );
      if (!current()) return;
      const result = await readAnswer(response, (partial) => {
        if (current()) this.#setAsk({ kind: 'pending', partial });
      });
      if (!current()) return;
      if (result.kind === 'error') {
        this.#setAsk({ kind: 'error', error: unavailable() });
        return;
      }
      const { answer } = result;
      this.#store.set((state) => ({
        status:
          state.status.kind === 'ready' ? { ...state.status, quota: answer.quota } : state.status,
        ask: { kind: 'done', answer },
      }));
    } catch (error) {
      if (!current() || isAbortError(error)) return;
      this.#fail(error);
    } finally {
      if (this.#askRequest === request) this.#askRequest = null;
    }
  }

  #setAsk(ask: CoachAsk): void {
    this.#store.set((state) => ({ ...state, ask }));
  }

  #fail(error: unknown): void {
    if (error instanceof AuthRequiredError || error instanceof NetworkError) {
      this.#setAsk({ kind: 'error', error: toErrorModel(error) });
      return;
    }
    if (!(error instanceof ApiError)) {
      this.#setAsk({ kind: 'error', error: unavailable() });
      return;
    }
    if (error.status === 429 && error.problem?.code === 'coach_quota_exceeded') {
      this.#store.set((state) => ({
        status:
          state.status.kind === 'ready'
            ? { ...state.status, quota: { ...state.status.quota, remaining: 0 } }
            : state.status,
        ask: { kind: 'error', error: { key: 'coach.quotaExhausted', authRequired: false } },
      }));
    } else if (error.status === 429) {
      this.#setAsk({
        kind: 'error',
        error: { key: 'coach.errors.rateLimited', authRequired: false },
      });
    } else if (error.status === 403) {
      this.#store.set((state) => ({
        status: state.status.kind === 'ready' ? { ...state.status, consent: false } : state.status,
        ask: { kind: 'idle' },
      }));
    } else if (error.status === 404) {
      this.#store.set({ status: { kind: 'disabled' }, ask: { kind: 'idle' } });
    } else {
      this.#setAsk({ kind: 'error', error: unavailable() });
    }
  }
}
