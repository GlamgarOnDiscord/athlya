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
 * - Failures before an HTTP response exists raise `NetworkError`.
 */
import { ProblemDetailsSchema, type ProblemDetails } from '@athlya/shared/schemas/problem';

import { ApiError, AuthRequiredError, NetworkError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Sent as `Idempotency-Key`; reuse the same value for every retry of one mutation. */
  readonly idempotencyKey?: string;
  /** `false` for anonymous endpoints (login, register): no token, no refresh on 401. */
  readonly authenticated?: boolean;
  readonly signal?: AbortSignal;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, the raw text for non-JSON bodies, or `null` when empty. */
  readonly body: unknown;
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
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
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

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await readBody(response) };
    } catch (error) {
      const reason = controller.signal.aborted
        ? external?.aborted === true
          ? 'request aborted'
          : `request timed out after ${String(timeoutMs)} ms`
        : 'network request failed';
      throw new NetworkError(`${method} ${url}: ${reason}`, { cause: error });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', forwardAbort);
    }
  }

  async function send(
    method: HttpMethod,
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<ApiResponse> {
    const url = buildUrl(options.baseUrl, path);
    const authenticated = requestOptions.authenticated ?? true;
    const token = authenticated ? options.tokens.getAccessToken() : null;
    const first = await attempt(method, url, body, requestOptions, token);
    if (first.status !== 401 || !authenticated) return first;

    const refreshed = options.refreshAccessToken ? await options.refreshAccessToken() : null;
    if (refreshed === null) throw new AuthRequiredError();
    const retried = await attempt(method, url, body, requestOptions, refreshed);
    if (retried.status === 401) throw new AuthRequiredError();
    return retried;
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
  };
}
