/**
 * `studio_domains`: custom web domain and e-mail sending domain of a
 * studio (migration 0053, issue #761).
 *
 * Column choices:
 *   - `(studio_id, kind)` is unique: one web domain and one sending
 *     domain per studio. A hostname may be claimed by several studios
 *     while pending; the partial unique index on `(kind, hostname)
 *     WHERE status = 'verified'` keeps a single verified owner, the
 *     studio able to publish its own `verification_token` in the DNS.
 *   - `dns_checks` stores the last lookup as an array of
 *     `{ purpose, check }` entries, read back when the API rebuilds the
 *     record list.
 *   - `dkim_record` and `activated_at` are operator columns: the
 *     application role has no UPDATE grant on them
 *     (`docs/runbooks/white-label-domains.md`).
 *   - A hostname change resets status, checks, DKIM value, verification
 *     and activation (trigger in the migration).
 *
 * Tenant isolation: FORCE RLS, policy `studio_domains_admin_own`.
 */

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey } from './_shared.js';
import { studios } from './studios.js';

/** One entry of `studio_domains.dns_checks`. */
export interface StoredDnsCheck {
  readonly purpose: string;
  readonly check: string;
}

export const studioDomains = pgTable(
  'studio_domains',
  {
    id: uuidPrimaryKey(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['web', 'email'] }).notNull(),
    hostname: text('hostname').notNull(),
    verificationToken: text('verification_token').notNull(),
    status: text('status', { enum: ['pending', 'verified', 'failed'] })
      .notNull()
      .default('pending'),
    dnsChecks: jsonb('dns_checks').$type<readonly StoredDnsCheck[]>(),
    dkimRecord: text('dkim_record'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('studio_domains_studio_kind_unique').on(table.studioId, table.kind),
    uniqueIndex('studio_domains_verified_hostname_unique')
      .on(table.kind, table.hostname)
      .where(sql`${table.status} = 'verified'`),
  ],
);

export type StudioDomainRow = typeof studioDomains.$inferSelect;
export type StudioDomainInsert = typeof studioDomains.$inferInsert;
