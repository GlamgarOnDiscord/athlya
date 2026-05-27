/**
 * Typed HTTP client shared by every caller in the web app.
 *
 * Responsibilities
 * ----------------
 *  - Attach `Authorization: Bearer <accessToken>` when a token is
 *    available via `getToken()`.
 *  - On `401`, invoke `onRefresh()` at most once to obtain a fresh
 *    access token, then retry the original request exactly once.
 *    A second `401` (or a `null` return from `onRefresh`) surfaces
 *    as an `ApiAuthError`.
 *  - On `4xx ≠ 401`, parse the Problem Details body (RFC 7807) and
 *    throw `ApiError` with the parsed payload.
 *  - On `5xx`, throw `ApiServerError`.
 *  - Network-level failures propagate as-is.
 *
 * The client is built via a factory so tests can inject a `fetchImpl`
 * stub (`vi.fn()`); production call sites instantiate one at module
 * load using `globalThis.fetch`.
 */
import type { ProblemDetails } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Error taxonomy                                                     */
/* ------------------------------------------------------------------ */

/**
 * 401 Unauthorized — the caller could not authenticate (no token,
 * refresh failed, or refreshed retry still 401'd).
 */
export class ApiAuthError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiAuthError';
    this.status = status;
    this.problem = problem;
  }
}

/**
 * Generic 4xx ≠ 401. Carries the parsed Problem Details body when the
 * server emits one, falling back to `undefined` for unexpected shapes.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/** 5xx — upstream failure, retryable by the caller. */
export class ApiServerError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiServerError';
    this.status = status;
    this.problem = problem;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface ApiClient {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
  del<T>(path: string, init?: RequestInit): Promise<T>;
  /**
   * PUT with a raw `BodyInit` (File, ArrayBuffer, Blob…). Unlike
   * `post`/`patch`, the body is NOT JSON-serialised — the caller is
   * responsible for setting the correct `Content-Type` header via
   * `init.headers`. Handles auth + the same 401-refresh-retry logic
   * as the other methods.
   */
  put<T>(path: string, body: BodyInit | null, init?: RequestInit): Promise<T>;
}

export interface CreateApiClientOptions {
  /** Base origin, e.g. `https://api.athlya.test` or `` to use same-origin paths. */
  readonly baseUrl: string;
  /** Returns the current in-memory access token, or `null`. */
  readonly getToken: () => string | null;
  /**
   * Optional refresh hook. When the server returns 401, the client
   * calls this once to obtain a fresh access token, then retries.
   * Return `null` to signal "refresh failed" and let the 401 surface
   * as `ApiAuthError`.
   */
  readonly onRefresh?: () => Promise<string | null>;
  /**
   * Fetch implementation override. Falls back to `globalThis.fetch`.
   * Primarily used by the test suite.
   */
  readonly fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Safely parse a Response body as Problem Details. Returns `undefined`
 * if the body is missing, non-JSON, or shaped differently — the caller
 * decides how to message the error when the payload is absent.
 */
async function tryParseProblem(response: Response): Promise<ProblemDetails | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return undefined;
  try {
    const body = (await response.clone().json()) as unknown;
    if (
      typeof body === 'object' &&
      body !== null &&
      'title' in body &&
      'status' in body &&
      typeof (body as { title: unknown }).title === 'string' &&
      typeof (body as { status: unknown }).status === 'number'
    ) {
      return body as ProblemDetails;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Assemble the final URL from the baseUrl + a caller-provided path. */
function buildUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//u.test(path)) return path;
  if (baseUrl === '') return path;
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Factory returning a fresh {@link ApiClient}. Always returns a new
 * object so tests can spin up independent instances without global
 * state leaking across them.
 */
export function createApiClient(opts: CreateApiClientOptions): ApiClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  /**
   * Low-level request executor. Accepts the already-built init +
   * attaches Authorization on every call. Exposed to the outer
   * scope so the 401-retry path can reuse it.
   */
  async function executeRaw(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = opts.getToken();
    if (token !== null && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetchImpl(url, { ...init, headers });
  }

  async function request<T>(
    method: Method,
    path: string,
    body: unknown,
    init: RequestInit | undefined,
  ): Promise<T> {
    const url = buildUrl(opts.baseUrl, path);
    const headers = new Headers(init?.headers);
    if (body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const baseInit: RequestInit = {
      ...init,
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let response = await executeRaw(url, baseInit);

    // 401 refresh-and-retry (at most once).
    if (response.status === 401 && opts.onRefresh) {
      const refreshed = await opts.onRefresh();
      if (refreshed === null) {
        const problem = await tryParseProblem(response);
        throw new ApiAuthError('Authentication refresh failed', 401, problem);
      }
      response = await executeRaw(url, baseInit);
    }

    if (response.ok) {
      // 204 No Content — no body to parse.
      if (response.status === 204) return undefined as T;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    }

    const problem = await tryParseProblem(response);
    const title = problem?.title ?? response.statusText;

    if (response.status === 401) {
      throw new ApiAuthError(title, 401, problem);
    }
    if (response.status === 429) {
      const retryAfterRaw = response.headers.get('retry-after');
      const parsed = Number.parseInt(retryAfterRaw ?? '', 10);
      const retryAfterSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
      const err = new Error('Rate limited') as Error & {
        status: number;
        retryAfterSec: number;
      };
      err.status = 429;
      err.retryAfterSec = retryAfterSec;
      throw err;
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ApiError(title, response.status, problem);
    }
    throw new ApiServerError(title, response.status, problem);
  }

  async function putRaw<T>(path: string, body: BodyInit | null, init?: RequestInit): Promise<T> {
    const url = buildUrl(opts.baseUrl, path);
    const headers = new Headers(init?.headers);
    const baseInit: RequestInit = {
      ...init,
      method: 'PUT',
      headers,
      ...(body !== null ? { body } : {}),
    };

    let response = await executeRaw(url, baseInit);

    if (response.status === 401 && opts.onRefresh) {
      const refreshed = await opts.onRefresh();
      if (refreshed === null) {
        const problem = await tryParseProblem(response);
        throw new ApiAuthError('Authentication refresh failed', 401, problem);
      }
      response = await executeRaw(url, baseInit);
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    }

    const problem = await tryParseProblem(response);
    const title = problem?.title ?? response.statusText;

    if (response.status === 401) throw new ApiAuthError(title, 401, problem);
    if (response.status >= 400 && response.status < 500) {
      throw new ApiError(title, response.status, problem);
    }
    throw new ApiServerError(title, response.status, problem);
  }

  return {
    get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
    post: <T>(path: string, body: unknown, init?: RequestInit) =>
      request<T>('POST', path, body, init),
    patch: <T>(path: string, body: unknown, init?: RequestInit) =>
      request<T>('PATCH', path, body, init),
    del: <T>(path: string, init?: RequestInit) => request<T>('DELETE', path, undefined, init),
    put: <T>(path: string, body: BodyInit | null, init?: RequestInit) =>
      putRaw<T>(path, body, init),
  };
}
