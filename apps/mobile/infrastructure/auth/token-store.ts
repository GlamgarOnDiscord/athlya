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

/** Tokens returned by `register`, `login`, `oauth/*` and `refresh`. */
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires. */
  readonly accessTokenExpiresIn: number;
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
   * Stores a freshly issued session: the rotated refresh token replaces the
   * previous one in secure storage, the access token stays in memory.
   */
  public async saveSession(tokens: SessionTokens): Promise<void> {
    await this.#secure.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    this.#accessToken = tokens.accessToken;
    this.#accessTokenExpiresAt = this.#now() + tokens.accessTokenExpiresIn * 1000;
    this.#unlocked = true;
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
   * locked. Resolves `true` when the refresh token may be read.
   */
  public async unlock(): Promise<boolean> {
    if (this.#unlocked) return true;
    if (!(await this.isBiometricUnlockEnabled())) {
      this.#unlocked = true;
      return true;
    }
    if (!(await this.#biometrics.isAvailable())) return false;
    this.#unlocked = await this.#biometrics.authenticate(this.#unlockPrompt);
    return this.#unlocked;
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
    this.#accessToken = null;
    this.#accessTokenExpiresAt = 0;
    this.#unlocked = false;
  }

  public async isBiometricUnlockEnabled(): Promise<boolean> {
    return (await this.#secure.getItem(BIOMETRIC_UNLOCK_KEY)) === 'true';
  }

  /**
   * Turning the unlock on requires available biometrics and a successful
   * prompt, so a user cannot lock themselves out. Resolves the new state.
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

  /** Sign-out: forgets both tokens. The biometric preference is kept. */
  public async clear(): Promise<void> {
    this.lock();
    await this.#secure.deleteItem(REFRESH_TOKEN_KEY);
  }
}
