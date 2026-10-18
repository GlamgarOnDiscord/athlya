import type { SecureStorage } from '../auth/ports';

export const STORAGE_KEY_ITEM = 'athlya.mmkvKey';

/**
 * Returns the per-install MMKV encryption key, creating it on first launch.
 * It lives in secure storage so the encrypted queue file is useless
 * without the device keystore.
 */
export async function loadOrCreateStorageKey(
  secure: SecureStorage,
  generate: () => string,
): Promise<string> {
  const existing = await secure.getItem(STORAGE_KEY_ITEM);
  if (existing !== null && existing !== '') return existing;
  const created = generate();
  await secure.setItem(STORAGE_KEY_ITEM, created);
  return created;
}

/** Lower-case hex encoding of raw bytes. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
