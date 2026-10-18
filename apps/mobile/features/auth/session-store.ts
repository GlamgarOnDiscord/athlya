/**
 * Whether a user is signed in, for routing: the screens behind the
 * sign-in gate redirect to `/login` once this reports `signed-out`.
 *
 * The source of truth is the token store (a stored user id means a stored
 * session). `refresh()` re-reads it after every sign-in and sign-out, and
 * after an `AuthRequiredError`, because a rejected refresh token clears
 * the store from inside the API client.
 */
import { Store } from '../store';

import type { TokenStore } from '../../infrastructure/auth/token-store';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly userId: string };

export class SessionStore {
  readonly #tokenStore: Pick<TokenStore, 'getUserId'>;
  readonly #store = new Store<SessionState>({ status: 'loading' });
  #generation = 0;

  public constructor(tokenStore: Pick<TokenStore, 'getUserId'>) {
    this.#tokenStore = tokenStore;
  }

  public readonly get = (): SessionState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Re-reads the stored user; the latest call wins over slower earlier ones. */
  public async refresh(): Promise<SessionState> {
    this.#generation += 1;
    const generation = this.#generation;
    let userId: string | null;
    try {
      userId = await this.#tokenStore.getUserId();
    } catch {
      userId = null;
    }
    if (generation === this.#generation) {
      const current = this.#store.get();
      const next: SessionState =
        userId === null ? { status: 'signed-out' } : { status: 'signed-in', userId };
      const unchanged =
        current.status === next.status &&
        (next.status !== 'signed-in' ||
          (current.status === 'signed-in' && current.userId === next.userId));
      if (!unchanged) this.#store.set(next);
    }
    return this.#store.get();
  }
}
