/**
 * Per-user Apple Health link, kept in the encrypted MMKV runtime store:
 * whether the member connected Apple Health on this device, the date the
 * import starts from, and the HealthKit anchor of the last imported page.
 * Keyed by user id, so another account signed in on the same device
 * starts unlinked.
 */
import { z } from 'zod';

import type { KeyValueStore } from '../storage/key-value-store';

export interface AppleHealthLink {
  /** Workouts that start before this instant (epoch ms) are never imported. */
  readonly sinceMs: number;
  /** HealthKit anchor after the last imported page, or null before the first. */
  readonly anchor: string | null;
}

const LinkSchema = z
  .object({
    sinceMs: z.number().int().nonnegative(),
    anchor: z.string().min(1).nullable(),
  })
  .strict();

const keyFor = (userId: string): string => `appleHealth.link.${userId}`;

export class AppleHealthLinkStore {
  readonly #store: KeyValueStore;

  public constructor(store: KeyValueStore) {
    this.#store = store;
  }

  /** The user's link, or null when not connected (or the entry is unreadable). */
  public get(userId: string): AppleHealthLink | null {
    const raw = this.#store.getString(keyFor(userId));
    if (raw === undefined) return null;
    try {
      const parsed = LinkSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Links the user, keeping an existing link (and its anchor) as is. */
  public connect(userId: string, sinceMs: number): AppleHealthLink {
    const existing = this.get(userId);
    if (existing !== null) return existing;
    const link: AppleHealthLink = { sinceMs, anchor: null };
    this.#write(userId, link);
    return link;
  }

  /** Records the anchor of an imported page; ignored once disconnected. */
  public saveAnchor(userId: string, anchor: string): void {
    const existing = this.get(userId);
    if (existing === null) return;
    this.#write(userId, { ...existing, anchor });
  }

  /** Forgets the link and its anchor; a later connect imports from scratch. */
  public disconnect(userId: string): void {
    this.#store.remove(keyFor(userId));
  }

  #write(userId: string, link: AppleHealthLink): void {
    this.#store.set(keyFor(userId), JSON.stringify(link));
  }
}
