/**
 * HTTP plumbing of the demo fake API (issue #750): turns a `Request` into
 * a plain {@link DemoRequest}, runs a router over a state kept in
 * `sessionStorage`, and turns its {@link DemoResponse} back into a
 * `Response` that the real API client parses as usual.
 */

export interface DemoRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface DemoResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface DemoBinaryBody {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** RFC 7807 body, the shape the API client maps onto its error classes. */
export function problem(status: number, title: string, code?: string): DemoResponse {
  return {
    status,
    body: { type: 'about:blank', title, status, ...(code !== undefined ? { code } : {}) },
  };
}

export function ok(body: unknown, status = 200): DemoResponse {
  return { status, body };
}

export const NO_CONTENT: DemoResponse = { status: 204 };

export function notFound(): DemoResponse {
  return problem(404, 'Not available in the demo', 'demo_not_available');
}

export function isBinaryBody(body: unknown): body is DemoBinaryBody {
  return typeof body === 'object' && body !== null && 'bytes' in body && 'contentType' in body;
}

export function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return (await request.json()) as unknown;
    } catch {
      return undefined;
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength === 0 ? undefined : { contentType, bytes };
}

export async function toDemoRequest(request: Request): Promise<DemoRequest> {
  const url = new URL(request.url);
  return {
    method: request.method.toUpperCase(),
    path: url.pathname.replace(/\/+$/u, '') || '/',
    query: url.searchParams,
    body: await readBody(request),
  };
}

export function toResponse(result: DemoResponse): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status });
  }
  const contentType =
    result.status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8';
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': contentType },
  });
}

/** Minimal storage surface, so tests can pass an in-memory one. */
export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads a state saved by a previous page of the same tab, or `null`. */
export function loadState<T extends { readonly schema: number }>(
  storage: DemoStorage | null,
  key: string,
  schema: number,
): T | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as T;
    return parsed.schema === schema ? parsed : null;
  } catch {
    return null;
  }
}

export function saveState(storage: DemoStorage | null, key: string, state: unknown): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // A full or blocked storage only costs the persistence across reloads.
  }
}

/** `window.sessionStorage`, or `null` where it is missing or blocked. */
export function browserSessionStorage(): DemoStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Short pause so loading states show up as they would against a real API. */
export function latency(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export function toDataUrl(body: DemoBinaryBody): string {
  let binary = '';
  for (let i = 0; i < body.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...body.bytes.subarray(i, i + 0x8000));
  }
  return `data:${body.contentType || 'application/octet-stream'};base64,${btoa(binary)}`;
}
