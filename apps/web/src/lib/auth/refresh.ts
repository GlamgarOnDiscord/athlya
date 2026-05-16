import { setAccessToken } from './token-store';

/**
 * Silent-refresh helper: exchanges the httpOnly `athlya.refresh` cookie
 * for a fresh access token via `/api/auth/refresh`.
 *
 * Passed as `onRefresh` to every `createApiClient` call so the client
 * retries a 401 once before surfacing it as `ApiAuthError`.
 */
export async function refreshAccessToken(): Promise<string | null> {
    try {
        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { readonly accessToken: string };
        setAccessToken(payload.accessToken);
        return payload.accessToken;
    } catch {
        return null;
    }
}
