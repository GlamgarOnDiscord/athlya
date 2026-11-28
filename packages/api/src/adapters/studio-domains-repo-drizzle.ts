/**
 * Drizzle-backed repository of `studio_domains` (migration 0053,
 * issue #761).
 *
 * Every query runs through `withTenantHttp` under the caller's claims:
 * the table is FORCE RLS and `studio_domains_admin_own` only lets an
 * admin of the studio see or write its rows. The application role has
 * no UPDATE grant on `activated_at` and `dkim_record`, which only an
 * operator sets, and a hostname change resets verification and
 * activation in a trigger, so `upsert` never has to touch them.
 */

import { isPostgresUniqueViolation, withTenantHttp } from '@athlya/db';
import { studioDomains } from '@athlya/db/schema';
import { and, eq } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { RecordCheck } from '../white-label/dns-records.js';
import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { StudioDomainRow } from '@athlya/db/schema';
import type { StudioDomainKind } from '@athlya/shared/schemas/api';

/** Thrown when another studio already verified the hostname. */
export class StudioDomainTakenError extends Error {
  public override readonly name = 'StudioDomainTakenError';
}

export interface StudioDomainCheckWrite {
  readonly status: 'pending' | 'verified' | 'failed';
  readonly checks: readonly RecordCheck[];
  readonly checkedAt: Date;
}

export interface StudioDomainsRepo {
  list(): Promise<readonly StudioDomainRow[]>;
  get(kind: StudioDomainKind): Promise<StudioDomainRow | null>;
  /** Register or replace the hostname of `kind`; a new hostname starts over. */
  upsert(kind: StudioDomainKind, hostname: string, token: string): Promise<StudioDomainRow>;
  remove(kind: StudioDomainKind): Promise<boolean>;
  /** @throws {StudioDomainTakenError} when the hostname is verified elsewhere. */
  saveCheck(kind: StudioDomainKind, write: StudioDomainCheckWrite): Promise<StudioDomainRow | null>;
}

export function createDrizzleStudioDomainsRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): StudioDomainsRepo {
  const studioId = claims.studioId;
  const ofKind = (kind: StudioDomainKind) =>
    and(eq(studioDomains.studioId, studioId), eq(studioDomains.kind, kind));

  return {
    async list() {
      return withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select()
            .from(studioDomains)
            .where(eq(studioDomains.studioId, studioId))
            .orderBy(studioDomains.kind),
        ),
      );
    },

    async get(kind) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(db, claims, db.select().from(studioDomains).where(ofKind(kind)).limit(1)),
      );
      return rows[0] ?? null;
    },

    async upsert(kind, hostname, token) {
      // A new hostname gets a new token; the trigger resets the
      // verification state of the replaced one.
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .insert(studioDomains)
            .values({ studioId, kind, hostname, verificationToken: token })
            .onConflictDoUpdate({
              target: [studioDomains.studioId, studioDomains.kind],
              set: { hostname, verificationToken: token },
            })
            .returning(),
        ),
      );
      const row = rows[0];
      if (row !== undefined) return row;
      throw new Error('studio domain upsert returned no row');
    },

    async remove(kind) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.delete(studioDomains).where(ofKind(kind)).returning({ id: studioDomains.id }),
        ),
      );
      return rows.length > 0;
    },

    async saveCheck(kind, write) {
      try {
        const rows = await withConnectionRetry(() =>
          withTenantHttp(
            db,
            claims,
            db
              .update(studioDomains)
              .set({
                status: write.status,
                dnsChecks: write.checks,
                lastCheckedAt: write.checkedAt,
                ...(write.status === 'verified' ? { verifiedAt: write.checkedAt } : {}),
              })
              .where(ofKind(kind))
              .returning(),
          ),
        );
        return rows[0] ?? null;
      } catch (err) {
        if (isPostgresUniqueViolation(err)) {
          throw new StudioDomainTakenError('hostname already verified by another studio', {
            cause: err,
          });
        }
        throw err;
      }
    },
  };
}
