/**
 * In-memory access-token store for the studio admin app.
 *
 * Bit-for-bit copy of `apps/web/src/lib/auth/token-store.ts`. The
 * access token never lives in `localStorage` or a cookie — only the
 * refresh token does (httpOnly), so an XSS escalation cannot exfil
 * the access token off-tab. See the rationale in the web copy.
 *
 * @see Requirements 1.1, 1.5, 2.3.
 */

type Listener = (token: string | null) => void;

let currentToken: string | null = null;
const listeners = new Set<Listener>();

export function getAccessToken(): string | null {
    return currentToken;
}

export function setAccessToken(token: string | null): void {
    currentToken = token;
    for (const listener of listeners) {
        listener(token);
    }
}

export function subscribeToAccessToken(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
