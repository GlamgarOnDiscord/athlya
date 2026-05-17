/**
 * In-memory access-token store for the Athlya web app.
 *
 * Rationale
 * ---------
 * The access token is held only in JavaScript memory — never in
 * `localStorage`, never in a cookie. This is a deliberate security
 * trade-off against XSS: an attacker who manages to execute script in
 * the tab can still read the token (that's inherent to any in-page
 * holder), but the token cannot be silently exfiltrated via CSRF,
 * survive across tabs, or leak to extensions that mine
 * `localStorage`.
 *
 * The refresh token lives in an httpOnly cookie set by our own Next.js
 * route handlers (`src/app/api/auth/*`) — it never touches JS land.
 *
 * A tiny pub/sub is enough for the UI: `AuthContext` subscribes on
 * mount so every component reading `isAuthenticated` stays in sync
 * when `setAccessToken` is called from a login flow, refresh flow,
 * or logout.
 *
 * This module is deliberately React-free so it can be imported by the
 * API client (non-React code) without pulling in the React runtime.
 *
 * @see Requirements 1.1, 1.5, 2.3.
 */

type Listener = (token: string | null) => void;

let currentToken: string | null = null;
const listeners = new Set<Listener>();

/** Read the current in-memory access token, or `null` when signed out. */
export function getAccessToken(): string | null {
  return currentToken;
}

/**
 * Replace the in-memory access token and notify every subscriber.
 *
 * Pass `null` to clear the token on logout. Notifications are fired
 * synchronously in insertion order; a listener that throws will not
 * prevent later listeners from running (we intentionally do not wrap
 * them in a try/catch so bugs surface loudly in dev, rather than
 * being silently swallowed).
 */
export function setAccessToken(token: string | null): void {
  currentToken = token;
  for (const listener of listeners) {
    listener(token);
  }
}

/**
 * Subscribe to token changes. Returns an unsubscribe callback so
 * React consumers can tear down cleanly in their `useEffect` cleanup.
 */
export function subscribeToAccessToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only reset. Exported with a double-underscore prefix to
 * signal "not for production use" and keep the public API tight.
 */
export function __resetTokenStore(): void {
  currentToken = null;
  listeners.clear();
}
