/**
 * Client-side auth context + `useAuth()` hook for the studio admin app.
 *
 * Mirrors `apps/web/src/lib/auth/AuthContext.tsx`. Beyond the basic
 * `{ accessToken, isAuthenticated, login, logout }` shape, the studio
 * provider also exposes `{ user, isAdmin }`:
 *
 *   - `user` carries the role + studioId from the `/api/auth/login`
 *     response so descendant client components can render UI tied
 *     to the active studio without a second fetch.
 *   - `isAdmin` is derived (`user?.role === 'admin'`). The studio app
 *     is admin-only — every protected page sits behind
 *     `<RequireAdmin>` (see `components/RequireAdmin.tsx`).
 *
 * The role gate is enforced server-side by the API gateway too
 * (`requireRole('admin')` middleware). The client check is purely a
 * UX shortcut so non-admin users see a friendly "no access" screen
 * instead of a flood of 403 responses on every page render.
 *
 * @see Requirements 1.1, 1.5, 2.3, 6.5.
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

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly studioId: string;
  readonly role: 'member' | 'coach' | 'admin';
}

interface LoginCredentials {
  readonly email: string;
  readonly password: string;
  readonly turnstileToken?: string;
}

export interface LoginResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
  readonly user: AuthUser;
}

export interface AuthContextValue {
  readonly accessToken: string | null;
  readonly user: AuthUser | null;
  readonly isAuthenticated: boolean;
  readonly isAdmin: boolean;
  /**
   * `true` once the boot silent-refresh has resolved (either
   * successfully grabbed a fresh access token, or determined that
   * the refresh cookie was absent / invalid). Route guards should
   * wait for this flag before deciding to redirect, otherwise a
   * legitimately-signed-in user is briefly redirected to /login
   * while the boot refresh is still in flight.
   */
  readonly bootResolved: boolean;
  readonly login: (credentials: LoginCredentials) => Promise<LoginResponse>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  readonly children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): ReactElement {
  const accessToken = useSyncExternalStore<string | null>(
    (onStoreChange) => subscribeToAccessToken(() => onStoreChange()),
    getAccessToken,
    () => null,
  );

  // Profile snapshot returned with the login response. Cleared on
  // logout. Not bridged to the token store because the studio user
  // never reads it from non-React code (unlike the access token,
  // which the API client consumes).
  const [bootState, setBootState] = useState<{
    user: AuthUser | null;
    resolved: boolean;
  }>(() => ({ user: null, resolved: false }));

  // Silent refresh on mount — same rationale as the member-facing
  // app (see `apps/web/src/lib/auth/AuthContext.tsx` for the full
  // doc). On a hard page reload the access token is gone but the
  // `athlya.refresh.studio` httpOnly cookie survives, so we trade
  // it for a fresh access token + user payload here.
  useEffect(() => {
    if (bootState.resolved) return;
    let cancelled = false;
    let resolvedUser: AuthUser | null = null;
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
            readonly user?: AuthUser;
          };
          setAccessToken(payload.accessToken);
          resolvedUser = payload.user ?? null;
        }
      } catch {
        // Stay signed-out.
      } finally {
        if (!cancelled) setBootState({ user: resolvedUser, resolved: true });
      }
    }
    void bootRefresh();
    return () => {
      cancelled = true;
    };
  }, [bootState.resolved]);

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
    setBootState((s) => ({ ...s, user: payload.user }));
    return payload;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = getAccessToken();
    if (token !== null) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers });
    } finally {
      setAccessToken(null);
      setBootState((s) => ({ ...s, user: null }));
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      user: bootState.user,
      isAuthenticated: accessToken !== null,
      isAdmin: bootState.user?.role === 'admin',
      bootResolved: bootState.resolved,
      login,
      logout,
    }),
    [accessToken, bootState, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be called within an <AuthProvider>');
  }
  return value;
}
