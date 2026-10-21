/**
 * Studio settings adapter (issue #759): reads and writes the settings
 * columns of migration 0053 under the caller's claims. The write goes
 * through `studios_admin_update_own` (admins of the studio only) and the
 * column-scoped grant of 0053.
 */

import { withTenantHttp } from '@athlya/db';
import { studios } from '@athlya/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';
import { getOrCreateDbHttp } from './deps-cache.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { StudioSettingsDeps } from '../routes/studio-settings.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { StudioSettings } from '@athlya/shared/schemas/api';

const columns = {
  name: studios.name,
  timezone: studios.timezone,
  addressLine: studios.addressLine,
  postalCode: studios.postalCode,
  city: studios.city,
  country: studios.country,
  contactEmail: studios.contactEmail,
};

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

export function createStudioSettingsRepo(db: AthlyaDbHttp): StudioSettingsDeps {
  const mine = (claims: AuthClaims) =>
    and(eq(studios.id, claims.studioId), isNull(studios.deletedAt));
  return {
    async getSettings(claims) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          toTenantClaims(claims),
          db.select(columns).from(studios).where(mine(claims)).limit(1),
        ),
      );
      return (rows[0] as StudioSettings | undefined) ?? null;
    },

    async updateSettings(claims, patch) {
      const set: Partial<typeof studios.$inferInsert> = {};
      for (const key of Object.keys(columns) as Array<keyof typeof columns>) {
        const value = patch[key];
        if (value !== undefined) (set as Record<string, unknown>)[key] = value;
      }
      // Same values written again: a replay after a dropped connection is safe.
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          toTenantClaims(claims),
          db.update(studios).set(set).where(mine(claims)).returning(columns),
        ),
      );
      return (rows[0] as StudioSettings | undefined) ?? null;
    },
  };
}

export function buildStudioSettingsDeps(env: AthlyaBindings): StudioSettingsDeps {
  return createStudioSettingsRepo(getOrCreateDbHttp(env.DB_URL));
}
