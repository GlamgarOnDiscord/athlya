/**
 * Typed HTTP client for the studio admin app. Bit-for-bit copy of
 * `apps/web/src/lib/api/client.ts`. Extracted as a separate module so
 * the studio bundle stays free of any web-app-specific surface (member
 * profile, etc.) and so per-app refresh policies can diverge later.
 *
 * Refresh hook expectation: callers pass an `onRefresh()` that POSTs
 * to `/api/auth/refresh` (the studio route handler), which the proxy
 * forwards to the upstream `/v1/auth/refresh`.
 */
import type { ProblemDetails } from '@athlya/shared/schemas';

class ApiAuthError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiAuthError';
    this.status = status;
    this.problem = problem;
  }
}

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

export interface ApiClient {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body: unknown, init?: RequestInit): Promise<T>;
  del<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface CreateApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly onRefresh?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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

function buildUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//u.test(path)) return path;
  if (baseUrl === '') return path;
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

export function createApiClient(opts: CreateApiClientOptions): ApiClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

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

  return {
    get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
    post: <T>(path: string, body: unknown, init?: RequestInit) =>
      request<T>('POST', path, body, init),
    patch: <T>(path: string, body: unknown, init?: RequestInit) =>
      request<T>('PATCH', path, body, init),
    del: <T>(path: string, init?: RequestInit) => request<T>('DELETE', path, undefined, init),
  };
}
