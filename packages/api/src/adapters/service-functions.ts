/**
 * Typed access to the SECURITY DEFINER service functions installed by
 * migration `0032_service_definer_functions.sql` (issue #224).
 *
 * Pre-authentication auth flows and the notifications / RGPD cascade
 * queue consumers run as `athlya_app` without tenant claims, so FORCE
 * RLS hides every row from raw table queries. Each of those paths calls
 * one narrow function instead; the function signature is the contract.
 * `service-functions.test.ts` keeps this module in sync with the
 * migration.
 */

import { sql, type SQL } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';

/** Row shape returned by the `auth_*` user functions (snake_case, as in SQL). */
export interface ServiceUserRow {
  readonly id: string;
  readonly studio_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: 'member' | 'coach' | 'admin';
  readonly password_hash: string | null;
  readonly deleted_at: Date | string | null;
  readonly credentials_version: number;
}

/**
 * Run `query` and return its rows for either driver: postgres-js
 * resolves to an array, the Neon HTTP driver to `{ rows }`.
 */
export async function queryRows<T>(db: AthlyaDbAny, query: SQL): Promise<T[]> {
  const execute = (db as { execute: (q: SQL) => PromiseLike<unknown> }).execute.bind(db);
  const result = await withConnectionRetry(async () => execute(query));
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}

/** `timestamptz` arrives as `Date` (postgres-js) or ISO string (Neon HTTP). */
export function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Single-integer result of the `rgpd_delete_*` functions. */
export async function callCount(db: AthlyaDbAny, query: SQL): Promise<number> {
  const rows = await queryRows<{ n: number | string }>(db, query);
  return Number(rows[0]?.n ?? 0);
}

export const serviceFn = {
  findActiveUserByEmail: (email: string) =>
    sql`SELECT * FROM auth_find_active_user_by_email(${email})`,
  findUserById: (id: string) => sql`SELECT * FROM auth_find_user_by_id(${id}::uuid)`,
  findStudioBySlug: (slug: string) => sql`SELECT * FROM auth_find_studio_by_slug(${slug})`,
  createMember: (input: {
    studioId: string;
    email: string;
    displayName: string;
    passwordHash: string | null;
    consents: unknown;
  }) =>
    sql`SELECT * FROM auth_create_member(${input.studioId}::uuid, ${input.email}, ${input.displayName}, ${input.passwordHash}, ${JSON.stringify(input.consents)}::jsonb)`,
  softDeleteUser: (id: string) => sql`SELECT auth_soft_delete_user(${id}::uuid)`,
  bumpCredentialsVersion: (id: string) => sql`SELECT auth_bump_credentials_version(${id}::uuid)`,
  consumePasswordReset: (tokenHash: string, userId: string, passwordHash: string) =>
    sql`SELECT id FROM auth_consume_password_reset(${tokenHash}, ${userId}::uuid, ${passwordHash}) AS id`,
  notificationRecipient: (userId: string) =>
    sql`SELECT * FROM notification_recipient(${userId}::uuid)`,
  deleteReservations: (userId: string) =>
    sql`SELECT rgpd_delete_reservations(${userId}::uuid) AS n`,
  deleteWorkoutSessions: (userId: string) =>
    sql`SELECT rgpd_delete_workout_sessions(${userId}::uuid) AS n`,
  deletePushTokens: (userId: string) => sql`SELECT rgpd_delete_push_tokens(${userId}::uuid) AS n`,
  deleteIdempotencyKeys: (userId: string) =>
    sql`SELECT rgpd_delete_idempotency_keys(${userId}::uuid) AS n`,
  restampUserDeleted: (userId: string, deletedAt: Date) =>
    sql`SELECT rgpd_restamp_user_deleted(${userId}::uuid, ${deletedAt.toISOString()}::timestamptz)`,
} as const;
