/**
 * Client-side auth context + `useAuth()` hook.
 *
 * Owns the React-level shape of the in-memory access token:
 *  - reads the initial value from the pub/sub store,
 *  - subscribes on mount so any call to `setAccessToken(...)` from a
 *    route handler or refresh flow propagates into React state,
 *  - exposes `login`, `logout` helpers that POST to the Next.js route
 *    handlers (`/api/auth/login`, `/api/auth/logout`) — those handlers
 *    are responsible for setting/clearing the `athlya.refresh`
 *    httpOnly cookie. The access token flows back in the JSON body
 *    and is placed into the token store here.
 *
 * The provider is intentionally minimal: it exposes `{ accessToken,
 * isAuthenticated, login, logout }`. Components that need richer
 * profile data call the `/me` endpoint through the API client.
 *
 * @see Requirements 1.1, 1.5, 2.3.
 */
'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import { getAccessToken, setAccessToken, subscribeToAccessToken } from './token-store';

/** Minimal shape consumed by the web app. Extended in future tasks. */
interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly studioId: string;
  readonly role: 'member' | 'coach' | 'admin';
}

export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
  /** Cloudflare Turnstile token, forwarded to the gateway middleware. */
  readonly turnstileToken?: string;
}

/**
 * Shape of the `/api/auth/login` success response. The refresh token
 * is stripped server-side — it only ever lives in the httpOnly cookie.
 */
export interface LoginResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
  readonly user: AuthUser;
}

export interface AuthContextValue {
  readonly accessToken: string | null;
  readonly isAuthenticated: boolean;
  /**
   * `true` once the boot silent-refresh has resolved. Route guards
   * (`<RequireAuth>`) should wait for this before redirecting to
   * /login, otherwise a refresh of a protected page briefly
   * bounces the user even when the refresh cookie is valid.
   */
  readonly bootResolved: boolean;
  readonly login: (credentials: LoginCredentials) => Promise<LoginResponse>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  readonly children: ReactNode;
}

/**
 * Wrap the app tree so `useAuth()` works in every descendant client
 * component. Mounted inside `app/layout.tsx` (inside the
 * `<LocaleProvider>` it inherits from).
 */
export function AuthProvider({ children }: AuthProviderProps): ReactElement {
  // Bridge the non-React token store into React via the canonical
  // external-store hook. `useSyncExternalStore` is tearing-proof
  // under concurrent rendering: every component reading the token
  // in the same render tree sees the exact same snapshot, even if
  // a mutation lands mid-render. The older `useState` + `useEffect`
  // bridge we had before was vulnerable to tearing in React 19
  // concurrent mode.
  //
  // The subscriber adapter discards the callback argument — the
  // store's listener signature carries the new token, but
  // `useSyncExternalStore` rereads the snapshot itself via
  // `getAccessToken` after each notification.
  const accessToken = useSyncExternalStore<string | null>(
    (onStoreChange) => subscribeToAccessToken(() => onStoreChange()),
    getAccessToken,
    // Server snapshot: always `null` at SSR time. The access token
    // lives only in client memory — server components render the
    // signed-out shape and hydrate to the real value once the
    // store is bridged on the client.
    () => null,
  );

  /**
   * Track the in-flight silent refresh so subsequent renders /
   * remounts don't fire a second one. Set to `true` once the boot
   * refresh has either succeeded or failed; the auth state then
   * stabilises (signed-in if the refresh cookie was valid,
   * signed-out otherwise).
   */
  const [bootRefreshDone, setBootRefreshDone] = useState<boolean>(false);

  // Silent refresh on mount.
  // ----------------------------------------------------------------
  // The access token lives only in JS memory (`token-store.ts`); a
  // hard refresh of the page wipes it. The httpOnly refresh cookie
  // (`athlya.refresh`) survives the reload, however, so we trade
  // it for a fresh access token via the existing `/api/auth/refresh`
  // route handler. Failures are silent: the app stays in the
  // signed-out state and route guards (`<RequireAuth>`) redirect
  // to `/login` as usual.
  //
  // Runs exactly once per AuthProvider mount. We do NOT re-trigger
  // on `accessToken` change because subsequent refreshes are
  // handled by the API client's 401-retry path
  // (`useApiClient(...).onRefresh`) — the boot refresh exists only
  // to bridge the page-load gap.
  useEffect(() => {
    if (bootRefreshDone) return;
    let cancelled = false;
    async function bootRefresh() {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
        });
        if (cancelled) return;
        if (response.ok) {
          const payload = (await response.json()) as {
            readonly accessToken: string;
          };
          setAccessToken(payload.accessToken);
        }
        // 401 / 502 / network error → stay signed-out; the
        // refresh cookie is either missing (first visit), gone
        // (logged out elsewhere) or invalid.
      } catch {
        // Swallow — same fallback as a non-2xx response.
      } finally {
        if (!cancelled) setBootRefreshDone(true);
      }
    }
    void bootRefresh();
    return () => {
      cancelled = true;
    };
  }, [bootRefreshDone]);

  const login = useCallback(async (credentials: LoginCredentials): Promise<LoginResponse> => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (credentials.turnstileToken !== undefined && credentials.turnstileToken !== '') {
      (headers as Record<string, string>)['cf-turnstile-token'] = credentials.turnstileToken;
    }
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });
    if (!response.ok) {
      // Let the caller read the Problem Details body.
      const err = new Error('Login failed') as Error & {
        status: number;
        body: unknown;
      };
      err.status = response.status;
      try {
        err.body = await response.json();
      } catch {
        err.body = undefined;
      }
      throw err;
    }
    const payload = (await response.json()) as LoginResponse;
    setAccessToken(payload.accessToken);
    return payload;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = getAccessToken();
    if (token !== null) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers,
      });
    } finally {
      setAccessToken(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      isAuthenticated: accessToken !== null,
      bootResolved: bootRefreshDone,
      login,
      logout,
    }),
    [accessToken, bootRefreshDone, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the auth context. Throws when called outside the provider
 * so a broken render tree surfaces immediately in development.
 */
export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be called within an <AuthProvider>');
  }
  return value;
}
