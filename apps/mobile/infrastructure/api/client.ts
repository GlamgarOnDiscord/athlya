/**
 * HTTP client for the Athlya API — task 11.4, Requirements 20.1 and 20.3.
 *
 * - Attaches `Authorization: Bearer <access token>` from the in-memory
 *   token source.
 * - On 401 it asks the session for a fresh access token once, then retries
 *   the request once. A second 401, or a failed refresh, raises
 *   `AuthRequiredError`.
 * - `idempotencyKey` is sent as the `Idempotency-Key` header, so a retried
 *   mutation is applied at most once by the API.
 * - `send` reports every HTTP status to the caller (the offline drain
 *   needs the raw status); the typed helpers throw `ApiError` on non-2xx.
 * - `postStream` asks for `text/event-stream` and hands back the unread
 *   body of a 2xx event stream. Expo's `fetch` (`expo/fetch`, installed as
 *   the global `fetch` since SDK 52) exposes the response body as a
 *   `ReadableStream`. The timeout only covers the wait for the response
 *   headers; the caller's `signal` keeps cancelling the body read.
 * - Failures before an HTTP response exists raise `NetworkError`.
 */
import { COACH_STREAM_ACCEPT, isEventStream } from '@athlya/shared/coach-stream';
import { ProblemDetailsSchema, type ProblemDetails } from '@athlya/shared/schemas/problem';

import { ApiError, AuthRequiredError, NetworkError } from './errors';

import type { ByteStream } from '@athlya/shared/sse';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /**
   * Cancels the request; the original abort error is rethrown (not a
   * `NetworkError`), so a cancelled write is never queued.
   */
  readonly signal?: AbortSignal;
  /** Sent as `Idempotency-Key`; reuse the same value for every retry of one mutation. */
  readonly idempotencyKey?: string;
  /** `false` for anonymous endpoints (login, register): no token, no refresh on 401. */
  readonly authenticated?: boolean;
  /**
   * `false` returns a 401 as is instead of refreshing the session and
   * retrying (e.g. sign-out, which must not prompt for biometrics or
   * outlive its own timeout).
   */
  readonly refreshOnUnauthorized?: boolean;
  /**
   * Extra request headers, e.g. `If-None-Match` or `cf-turnstile-token` on
   * sign-in. `Accept`, `Content-Type`, `Authorization` and `Idempotency-Key`
   * belong to the client: a copy of one of them here is ignored, whatever its
   * case.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, the raw text for non-JSON bodies, or `null` when empty. */
  readonly body: unknown;
}

export interface StreamResponse extends ApiResponse {
  /**
   * The unread body of a 2xx `text/event-stream` answer, else `null` (and
   * `body` holds the parsed answer, e.g. a problem or a JSON payload).
   */
  readonly stream: ByteStream | null;
}

export interface AccessTokenSource {
  getAccessToken(): string | null;
}

export interface ApiClient {
  send(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiResponse>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  del<T>(path: string, options?: RequestOptions): Promise<T>;
  /** POST asking for a server-sent event stream; same auth and refresh as `send`. */
  postStream(path: string, body: unknown, options?: RequestOptions): Promise<StreamResponse>;
}

export interface CreateApiClientOptions {
  /** API origin, e.g. `https://api.athlya.app`. */
  readonly baseUrl: string;
  readonly tokens: AccessTokenSource;
  /**
   * Returns a fresh access token, or `null` when the session cannot be
   * refreshed. Concurrent callers should share one in-flight refresh
   * because refresh tokens are single-use.
   */
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  /** Per-attempt timeout; defaults to 15 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Headers the client owns; a caller-supplied copy, in any case, is dropped. */
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization', 'idempotency-key']);

function extraHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !RESERVED_HEADERS.has(name.toLowerCase())),
  );
}

export function parseProblem(body: unknown): ProblemDetails | undefined {
  const parsed = ProblemDetailsSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function createApiClient(options: CreateApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function attempt(
    method: HttpMethod,
    url: string,
    body: unknown,
    requestOptions: RequestOptions,
    accessToken: string | null,
    streaming = false,
  ): Promise<StreamResponse> {
    const headers: Record<string, string> = { ...extraHeaders(requestOptions.headers) };
    headers.Accept = streaming ? COACH_STREAM_ACCEPT : 'application/json';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken !== null) headers.Authorization = `Bearer ${accessToken}`;
    if (requestOptions.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const external = requestOptions.signal;
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (external?.aborted === true) controller.abort();
    external?.addEventListener('abort', forwardAbort);
    let streamOpen = false;

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        streaming &&
        response.ok &&
        response.body !== null &&
        isEventStream(response.headers.get('content-type'))
      ) {
        streamOpen = true;
        return {
          status: response.status,
          headers: response.headers,
          body: null,
          stream: response.body,
        };
      }
      return {
        status: response.status,
        headers: response.headers,
        body: await readBody(response),
        stream: null,
      };
    } catch (error) {
      // A caller cancellation is not a transport failure: surface it as is so
      // it is never mistaken for "offline" and queued for a retry.
      if (external?.aborted === true) throw error;
      const reason = controller.signal.aborted
        ? `request timed out after ${String(timeoutMs)} ms`
        : 'network request failed';
      throw new NetworkError(`${method} ${url}: ${reason}`, { cause: error });
    } finally {
      clearTimeout(timer);
      // An open stream still needs the caller's abort to cancel its body.
      if (!streamOpen) external?.removeEventListener('abort', forwardAbort);
    }
  }

  async function exchange(
    method: HttpMethod,
    path: string,
    body: unknown,
    requestOptions: RequestOptions,
    streaming: boolean,
  ): Promise<StreamResponse> {
    const url = buildUrl(options.baseUrl, path);
    const authenticated = requestOptions.authenticated ?? true;
    const token = authenticated ? options.tokens.getAccessToken() : null;
    const first = await attempt(method, url, body, requestOptions, token, streaming);
    if (first.status !== 401 || !authenticated || requestOptions.refreshOnUnauthorized === false) {
      return first;
    }

    const refreshed = options.refreshAccessToken ? await options.refreshAccessToken() : null;
    if (refreshed === null) throw new AuthRequiredError();
    const retried = await attempt(method, url, body, requestOptions, refreshed, streaming);
    if (retried.status === 401) throw new AuthRequiredError();
    return retried;
  }

  async function send(
    method: HttpMethod,
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<ApiResponse> {
    const {
      status,
      headers,
      body: payload,
    } = await exchange(method, path, body, requestOptions, false);
    return { status, headers, body: payload };
  }

  async function expectOk<T>(response: Promise<ApiResponse>): Promise<T> {
    const { status, body } = await response;
    if (status >= 200 && status < 300) return body as T;
    throw new ApiError(status, parseProblem(body));
  }

  return {
    send,
    get: (path, requestOptions) => expectOk(send('GET', path, undefined, requestOptions)),
    post: (path, body, requestOptions) => expectOk(send('POST', path, body, requestOptions)),
    put: (path, body, requestOptions) => expectOk(send('PUT', path, body, requestOptions)),
    patch: (path, body, requestOptions) => expectOk(send('PATCH', path, body, requestOptions)),
    del: (path, requestOptions) => expectOk(send('DELETE', path, undefined, requestOptions)),
    postStream: (path, body, requestOptions = {}) =>
      exchange('POST', path, body, requestOptions, true),
  };
}
