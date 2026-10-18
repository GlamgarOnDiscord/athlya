import { randomUUID } from 'node:crypto';

import { TokenStore } from '../infrastructure/auth/token-store';
import { createMemoryKeyValueStore } from '../infrastructure/storage/key-value-store';
import { MutationQueue } from '../infrastructure/sync/queue';

import type { BiometricAuthenticator, SecureStorage } from '../infrastructure/auth/ports';

export const OWNER = 'user-1';

export function createQueue(backing = new Map<string, string>()): {
  queue: MutationQueue;
  backing: Map<string, string>;
} {
  return {
    queue: new MutationQueue(createMemoryKeyValueStore(backing), { uuid: randomUUID }),
    backing,
  };
}

export class FakeSecureStorage implements SecureStorage {
  public readonly items = new Map<string, string>();

  public getItem(key: string): Promise<string | null> {
    return Promise.resolve(this.items.get(key) ?? null);
  }

  public setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
    return Promise.resolve();
  }

  public deleteItem(key: string): Promise<void> {
    this.items.delete(key);
    return Promise.resolve();
  }
}

export class FakeBiometrics implements BiometricAuthenticator {
  public available = true;
  public accept = true;
  public prompts = 0;
  /** When set, prompts stay open until this promise settles. */
  public hold: Promise<void> | null = null;

  public isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  public async authenticate(): Promise<boolean> {
    this.prompts += 1;
    await this.hold;
    return this.accept;
  }
}

export function createTokenStore(now: () => number = () => 1_000_000): {
  store: TokenStore;
  secure: FakeSecureStorage;
  biometrics: FakeBiometrics;
} {
  const secure = new FakeSecureStorage();
  const biometrics = new FakeBiometrics();
  return { store: new TokenStore(secure, biometrics, { now }), secure, biometrics };
}

export function jsonResponse(
  status: number,
  body?: unknown,
  contentType = 'application/json',
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}
