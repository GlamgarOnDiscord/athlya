/**
 * Drizzle-backed store of a member's notification preferences
 * (`users.notification_preferences`, migration 0054, issue #762).
 *
 * Both queries run through `withTenantHttp` under the caller's claims:
 * `users` is FORCE RLS and `users_update_own` only lets a member write
 * their own row. The column holds the channels turned off only; the
 * read resolves it to the full toggles the API returns.
 */

import { withTenantHttp } from '@athlya/db';
import { users } from '@athlya/db/schema';
import {
  resolveNotificationPreferences,
  storeNotificationPreferences,
} from '@athlya/shared/schemas/api';
import { and, eq, isNull } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { NotificationPreferences } from '@athlya/shared/schemas/api';

export interface NotificationPreferencesRepo {
  /** Full toggles of the member, `null` when the row is gone. */
  get(userId: string): Promise<NotificationPreferences | null>;
  /** Replace the toggles; `null` when the row is gone. */
  replace(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences | null>;
}

export function createDrizzleNotificationPreferencesRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): NotificationPreferencesRepo {
  const live = (userId: string) => and(eq(users.id, userId), isNull(users.deletedAt));

  return {
    async get(userId) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select({ stored: users.notificationPreferences })
            .from(users)
            .where(live(userId))
            .limit(1),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : resolveNotificationPreferences(row.stored);
    },

    async replace(userId, preferences) {
      // Same value on replay, so the retry after a dropped connection is safe.
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(users)
            .set({ notificationPreferences: storeNotificationPreferences(preferences) })
            .where(live(userId))
            .returning({ stored: users.notificationPreferences }),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : resolveNotificationPreferences(row.stored);
    },
  };
}
