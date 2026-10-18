/**
 * Session token storage — tasks 11.2 and 11.3, Requirements 1.5, 1.7, 2.1
 * and 2.2.
 *
 * - The access token (15 min) lives in memory only and is replaced on
 *   every refresh.
 * - The refresh token (30 days, single-use) lives only in the platform
 *   secure storage and is overwritten by each rotation.
 * - When biometric unlock is enabled, reading the stored refresh token
 *   requires a successful biometric prompt once per unlocked period; a
 *   fresh sign-in or `lock()` resets that period.
 */
import type { BiometricAuthenticator, SecureStorage } from './ports';
import type { AccessTokenSource } from '../api/client';

export const REFRESH_TOKEN_KEY = 'athlya.refreshToken';
export const BIOMETRIC_UNLOCK_KEY = 'athlya.biometricUnlock';
export const USER_ID_KEY = 'athlya.userId';

/** Tokens returned by `register`, `login`, `oauth/*` and `refresh`. */
export interface SessionTokens {
  /** Id of the signed-in user; owns the offline mutations made meanwhile. */
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires. */
  readonly accessTokenExpiresIn: number;
}

/** Snapshot taken by a refresh before its request; see `TokenStore.generation()`. */
export interface SessionGeneration {
  readonly epoch: number;
  readonly lock: number;
}

export interface TokenStoreOptions {
  readonly now?: () => number;
  readonly unlockPrompt?: string;
  /** Access tokens are treated as expired this many ms early. */
  readonly expirySkewMs?: number;
}

const DEFAULT_SKEW_MS = 30_000;

export class TokenStore implements AccessTokenSource {
  readonly #secure: SecureStorage;
  readonly #biometrics: BiometricAuthenticator;
  readonly #now: () => number;
  readonly #unlockPrompt: string;
  readonly #skewMs: number;
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  #unlocked = false;
  #unlocking: Promise<boolean> | null = null;
  #lockGeneration = 0;
  #epoch = 0;

  public constructor(
    secure: SecureStorage,
    biometrics: BiometricAuthenticator,
    options: TokenStoreOptions = {},
  ) {
    this.#secure = secure;
    this.#biometrics = biometrics;
    this.#now = options.now ?? Date.now;
    this.#unlockPrompt = options.unlockPrompt ?? 'Unlock Athlya';
    this.#skewMs = options.expirySkewMs ?? DEFAULT_SKEW_MS;
  }

  /** In-memory access token, or `null` once it is (about to be) expired. */
  public getAccessToken(): string | null {
    if (this.#accessToken === null) return null;
    if (this.#now() >= this.#accessTokenExpiresAt - this.#skewMs) return null;
    return this.#accessToken;
  }

  /**
   * Generation counters a refresh captures before its request and passes to
   * `saveSession`: `epoch` is bumped by `clear()` (sign-out), `lock` by
   * `lock()`. A response that lands after either cannot unlock the session.
   */
  public generation(): SessionGeneration {
    return { epoch: this.#epoch, lock: this.#lockGeneration };
  }

  /**
   * Stores a freshly issued session: the rotated refresh token replaces the
   * previous one in secure storage, the access token stays in memory.
   * With `expected`, a save after a sign-out stores nothing, and a save
   * after a `lock()` keeps the rotated refresh token (the old one is spent)
   * but leaves the store locked with no access token. Resolves whether the
   * session is now usable.
   */
  public async saveSession(tokens: SessionTokens, expected?: SessionGeneration): Promise<boolean> {
    if (expected !== undefined && expected.epoch !== this.#epoch) return false;
    await this.#secure.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    await this.#secure.setItem(USER_ID_KEY, tokens.userId);
    if (expected !== undefined && expected.epoch !== this.#epoch) {
      await this.#forget();
      return false;
    }
    if (expected !== undefined && expected.lock !== this.#lockGeneration) return false;
    this.#accessToken = tokens.accessToken;
    this.#accessTokenExpiresAt = this.#now() + tokens.accessTokenExpiresIn * 1000;
    this.#unlocked = true;
    return true;
  }

  /** Id of the user whose session is stored, or `null` when signed out. */
  public getUserId(): Promise<string | null> {
    return this.#secure.getItem(USER_ID_KEY);
  }

  /** Whether a refresh token is stored, without prompting. */
  public async hasStoredSession(): Promise<boolean> {
    return (await this.#secure.getItem(REFRESH_TOKEN_KEY)) !== null;
  }

  public isUnlocked(): boolean {
    return this.#unlocked;
  }

  /**
   * Prompts for biometrics when the unlock is enabled and the store is
   * locked. Resolves `true` when the refresh token may be read. Concurrent
   * callers share one prompt.
   */
  public unlock(): Promise<boolean> {
    if (this.#unlocked) return Promise.resolve(true);
    this.#unlocking ??= this.#runUnlock().finally(() => {
      this.#unlocking = null;
    });
    return this.#unlocking;
  }

  async #runUnlock(): Promise<boolean> {
    const generation = this.#lockGeneration;
    let unlocked: boolean;
    if (!(await this.isBiometricUnlockEnabled())) {
      unlocked = true;
    } else if (!(await this.#biometrics.isAvailable())) {
      unlocked = false;
    } else {
      unlocked = await this.#biometrics.authenticate(this.#unlockPrompt);
    }
    // A lock() issued while the prompt was open wins over its result.
    if (generation !== this.#lockGeneration) return false;
    this.#unlocked = unlocked;
    return unlocked;
  }

  /**
   * Returns the stored refresh token, gated by the biometric unlock.
   * `null` when nothing is stored or the user declined the prompt.
   */
  public async readRefreshToken(): Promise<string | null> {
    if (!(await this.unlock())) return null;
    return this.#secure.getItem(REFRESH_TOKEN_KEY);
  }

  /** Drops the in-memory access token and requires a new unlock. */
  public lock(): void {
    this.#lockGeneration += 1;
    this.#unlocking = null;
    this.#accessToken = null;
    this.#accessTokenExpiresAt = 0;
    this.#unlocked = false;
  }

  public async isBiometricUnlockEnabled(): Promise<boolean> {
    return (await this.#secure.getItem(BIOMETRIC_UNLOCK_KEY)) === 'true';
  }

  /**
   * Turning the unlock on requires available biometrics and a successful
   * prompt, so a user cannot lock themselves out. Resolves the new state:
   * `setBiometricUnlockEnabled(true)` resolves `false`, enabling nothing,
   * when biometrics are unavailable or the prompt is declined.
   */
  public async setBiometricUnlockEnabled(enabled: boolean): Promise<boolean> {
    if (!enabled) {
      await this.#secure.deleteItem(BIOMETRIC_UNLOCK_KEY);
      return false;
    }
    if (!(await this.#biometrics.isAvailable())) return false;
    if (!(await this.#biometrics.authenticate(this.#unlockPrompt))) return false;
    await this.#secure.setItem(BIOMETRIC_UNLOCK_KEY, 'true');
    this.#unlocked = true;
    return true;
  }

  /**
   * Sign-out: forgets both tokens and the user id, and invalidates any
   * refresh still in flight. The biometric preference is kept.
   */
  public async clear(): Promise<void> {
    this.#epoch += 1;
    await this.#forget();
  }

  async #forget(): Promise<void> {
    this.lock();
    await this.#secure.deleteItem(REFRESH_TOKEN_KEY);
    await this.#secure.deleteItem(USER_ID_KEY);
  }
}
