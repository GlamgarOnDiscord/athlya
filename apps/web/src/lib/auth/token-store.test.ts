/**
 * Unit tests for the in-memory access-token store.
 *
 * The store exposes a tiny pub/sub (no React) so these four cases
 * cover the full contract: initial value, roundtrip, listener
 * notification and clean unsubscribe.
 *
 * @see Requirements 1.1, 1.5, 2.3.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    __resetTokenStore,
    getAccessToken,
    setAccessToken,
    subscribeToAccessToken,
} from './token-store';

describe('token-store', () => {
    afterEach(() => {
        __resetTokenStore();
    });

    it('returns null by default before any token is set', () => {
        expect(getAccessToken()).toBeNull();
    });

    it('round-trips the token value via set / get', () => {
        setAccessToken('jwt.token.value');
        expect(getAccessToken()).toBe('jwt.token.value');
    });

    it('notifies every subscribed listener on set', () => {
        const listener = vi.fn();
        subscribeToAccessToken(listener);
        setAccessToken('abc');
        setAccessToken(null);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenNthCalledWith(1, 'abc');
        expect(listener).toHaveBeenNthCalledWith(2, null);
    });

    it('stops notifying a listener once its unsubscribe fn is called', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToAccessToken(listener);
        setAccessToken('first');
        unsubscribe();
        setAccessToken('second');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('first');
    });
});
