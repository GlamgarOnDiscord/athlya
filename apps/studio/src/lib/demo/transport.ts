/**
 * Browser transport of the demo mode (issue #750).
 *
 * In a demo build, {@link installDemoTransport} wraps `window.fetch` once,
 * before the first render, so every request aimed at the API (the
 * `NEXT_PUBLIC_API_URL` origin, or a same-origin `/v1/*` path) and every
 * call to the BFF auth routes (`/api/auth/*`) is answered by the
 * in-memory fake API instead of the network. Every other request (RSC
 * payloads, assets) goes through untouched.
 *
 * The fake API and its fixtures are loaded on the first intercepted
 * request through a dynamic import that sits behind the inline flag
 * check: a normal build folds the check to `false` and never bundles
 * them.
 */
import { getPublicApiUrl } from '../env';

type DemoHandler = (request: Request) => Promise<Response>;

function originOf(raw: string): string | null {
  if (raw === '') return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** True when `url` is a request the fake API answers. */
export function isDemoRequest(url: URL, pageOrigin: string, apiOrigin: string | null): boolean {
  if (apiOrigin !== null && url.origin === apiOrigin) return true;
  if (url.origin !== pageOrigin) return false;
  return url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/v1/');
}

let installed = false;

export function installDemoTransport(): void {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const network = window.fetch.bind(window);
  const apiOrigin = originOf(getPublicApiUrl());
  let handler: Promise<DemoHandler> | null = null;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!isDemoRequest(url, window.location.origin, apiOrigin)) return network(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    handler ??= import('./fake-api').then((module) => module.createDemoHandler());
    return (await handler)(request);
  };
}
