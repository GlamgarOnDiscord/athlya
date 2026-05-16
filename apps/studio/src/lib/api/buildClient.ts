/**
 * Hook factory that wires the typed `ApiClient` to the studio's auth
 * + refresh chain.
 *
 * The client reads the access token from the in-memory store
 * (`token-store.ts`) on every request, attaches `Authorization:
 * Bearer <token>` via the `Authorization` header, and on a 401
 * delegates to `onRefresh()` which POSTs to `/api/auth/refresh`. A
 * successful refresh returns the new access token; the client
 * retries the original request once before giving up.
 *
 * Why a hook (`useApiClient`) and not a module-scope singleton?
 * ------------------------------------------------------------
 * Several React 19 strict-mode subtleties argue for per-call
 * memoisation:
 *   - The token store is React-aware via `useSyncExternalStore`,
 *     so building the client inside a `useMemo` keyed on the
 *     `auth` context guarantees the closure captures the latest
 *     refresh hook without leaking stale state across logouts.
 *   - The `onRefresh` callback closes over `setAccessToken` from
 *     the auth context — module-scope wiring would have to import
 *     React-bound state, which is the very thing we want to avoid
 *     in a `lib/` module.
 *
 * @see Requirements 1.5, 2.2, 2.3, 14.1.
 */
'use client';

import { useMemo } from 'react';

import { setAccessToken } from '../auth/token-store';
import { getPublicApiUrl } from '../env';

import { createApiClient, type ApiClient } from './client';

/**
 * Build the API client once per render of a component that calls
 * `useApiClient()`. Memoised on `getToken` identity so re-renders
 * inside a stable auth state share the same instance.
 */
export function useApiClient(getToken: () => string | null): ApiClient {
  return useMemo(() => {
    const baseUrl = getPublicApiUrl();
    return createApiClient({
      baseUrl,
      getToken,
      onRefresh: async () => {
        try {
          const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
            },
          });
          if (!response.ok) {
            // Refresh failed — clear the in-memory token
            // so the auth context flips to "signed out"
            // immediately and the gate redirects to /login.
            setAccessToken(null);
            return null;
          }
          const payload = (await response.json()) as {
            readonly accessToken: string;
          };
          setAccessToken(payload.accessToken);
          return payload.accessToken;
        } catch {
          setAccessToken(null);
          return null;
        }
      },
    });
  }, [getToken]);
}
