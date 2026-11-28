/**
 * Compose the router-level `StudiosDeps` bundle from a live
 * `AthlyaBindings` env: slice B9.1 + B9.2, white label (issue #761).
 *
 * Wiring:
 *   - studio row: Drizzle repo over the shared HTTP driver;
 *   - logos: {@link createStudioLogoStore} (R2 when the avatar bucket
 *     and its public URL are configured, capped data: URL otherwise);
 *   - custom domains: Drizzle repo of `studio_domains` and the DNS over
 *     HTTPS resolver for "check now".
 *
 * Every query runs under the caller's tenant claims (`withTenantHttp`,
 * issue #224): `studios` and `studio_domains` are FORCE RLS and a
 * claim-less query sees no row under the `athlya_app` runtime role.
 *
 * @see Requirements 13.2, 15.2 (brand color), 13.5 (no cross-tenant
 *      disclosure).
 */

import {
  checkRecords,
  domainVerdict,
  expectedRecords,
  StudioDomainCheckCooldownError,
  toStudioDomainView,
} from '../white-label/dns-records.js';

import { getOrCreateDbHttp } from './deps-cache.js';
import { createDohLookup } from './doh-resolver.js';
import { createDrizzleStudioDomainsRepoHttp } from './studio-domains-repo-drizzle.js';
import { createStudioLogoStore } from './studio-logo-store.js';
import { createDrizzleStudioRepoHttp, type StudioRepo } from './studios-repo-drizzle.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { StudiosDeps } from '../routes/studios.js';
import type { AthlyaBindings } from '../types.js';
import type { DnsLookup } from '../white-label/dns-records.js';
import type { TenantClaims } from '@athlya/db/client';

/** Minimum delay between two DNS checks of the same domain. */
export const DOMAIN_CHECK_COOLDOWN_MS = 10_000;

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

/** 128-bit random token, hex, for the ownership TXT record. */
function newVerificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StudiosDepsOptions {
  readonly lookup?: DnsLookup;
  readonly now?: () => number;
}

/**
 * Produce the {@link StudiosDeps} bundle consumed by
 * {@link buildStudiosRouter}. Each method pulls the shared HTTP
 * Drizzle handle from the per-isolate cache and builds the
 * lightweight tenant-scoped repo fresh per call.
 */
export function buildStudiosDeps(
  env: AthlyaBindings,
  options: StudiosDepsOptions = {},
): StudiosDeps {
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? createDohLookup();
  const db = () => getOrCreateDbHttp(env.DB_URL);
  const repoFor = (claims: AuthClaims): StudioRepo =>
    createDrizzleStudioRepoHttp(db(), toTenantClaims(claims));
  const domainsFor = (claims: AuthClaims) =>
    createDrizzleStudioDomainsRepoHttp(db(), toTenantClaims(claims));
  const logos = createStudioLogoStore(env.AVATARS_BUCKET, env.AVATARS_PUBLIC_URL, now);
  const logoField = { light: 'brandLogoLight', dark: 'brandLogoDark' } as const;

  return {
    async getStudio(studioId, claims) {
      return repoFor(claims).getById(studioId);
    },

    async updateStudio(studioId, patch, claims) {
      return repoFor(claims).updateById(studioId, patch);
    },

    async uploadLogo(variant, contentType, body, claims) {
      const value = await logos.put(claims.studioId, variant, contentType, body);
      return repoFor(claims).updateById(claims.studioId, { [logoField[variant]]: value });
    },

    async removeLogo(variant, claims) {
      await logos.remove(claims.studioId, variant);
      return repoFor(claims).updateById(claims.studioId, { [logoField[variant]]: null });
    },

    async listDomains(claims) {
      const rows = await domainsFor(claims).list();
      return rows.map(toStudioDomainView);
    },

    async setDomain(kind, hostname, claims) {
      const repo = domainsFor(claims);
      const existing = await repo.get(kind);
      // Same hostname again: keep the row and its token, so a double
      // submit does not invalidate a TXT record already published.
      if (existing !== null && existing.hostname === hostname) {
        return toStudioDomainView(existing);
      }
      return toStudioDomainView(await repo.upsert(kind, hostname, newVerificationToken()));
    },

    async removeDomain(kind, claims) {
      return domainsFor(claims).remove(kind);
    },

    async checkDomain(kind, claims) {
      const repo = domainsFor(claims);
      const row = await repo.get(kind);
      if (row === null) return null;
      const started = now();
      if (row.lastCheckedAt !== null) {
        const elapsed = started - row.lastCheckedAt.getTime();
        if (elapsed < DOMAIN_CHECK_COOLDOWN_MS) {
          throw new StudioDomainCheckCooldownError(
            Math.ceil((DOMAIN_CHECK_COOLDOWN_MS - elapsed) / 1000),
          );
        }
      }
      const records = expectedRecords(
        row.kind,
        row.hostname,
        row.verificationToken,
        row.dkimRecord,
      );
      const checks = await checkRecords(records, lookup);
      const saved = await repo.saveCheck(kind, {
        status: domainVerdict(records, checks),
        checks,
        checkedAt: new Date(started),
      });
      return saved === null ? null : toStudioDomainView(saved);
    },
  };
}
