/**
 * Typed access to the SECURITY DEFINER service functions installed by
 * migrations `0032_service_definer_functions.sql` (issue #224),
 * `0033_auth_event_recording.sql` (issue #411),
 * `0037_auth_outbox_review_fixes.sql` (issue #609),
 * `0038_studios_runtime.sql` (issue #224, tenant slug resolution) and
 * `0039_runtime_rls_gaps.sql` (issue #117, password reset issuance and
 * RGPD audit anonymisation) and `0043_auth_password_reset_outbox.sql`
 * (issue #645, durable password-reset requests).
 *
 * Pre-authentication auth flows, the tenant slug guard and the
 * notifications / RGPD cascade queue consumers run as `athlya_app`
 * without tenant claims, so FORCE RLS hides every row from raw table
 * queries. Each of those paths calls
 * one narrow function instead; the function signature is the contract.
 * `service-functions.test.ts` keeps this module in sync with the
 * migrations.
 */

import { sql, type SQL } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type { Role } from '@athlya/shared/roles';

/**
 * Row shape returned by the `auth_*` user functions (snake_case, as in SQL).
 *
 * `email` is NULL only for a soft-deleted user anonymised by the RGPD
 * purge (migration 0041, issue #628), which `auth_find_user_by_id` can
 * still return. Callers narrow it before use.
 */
export interface ServiceUserRow {
  readonly id: string;
  readonly studio_id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly role: Role;
  readonly password_hash: string | null;
  readonly deleted_at: Date | string | null;
  readonly credentials_version: number;
}

function execute(db: AthlyaDbAny, query: SQL): Promise<unknown> {
  const run = (db as { execute: (q: SQL) => PromiseLike<unknown> }).execute.bind(db);
  return Promise.resolve(run(query));
}

/** postgres-js resolves to an array, the Neon HTTP driver to `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}

/**
 * Run a read, or a call that is idempotent on replay, and return its
 * rows. Retried once when the connection was dropped.
 */
export async function queryRows<T>(db: AthlyaDbAny, query: SQL): Promise<T[]> {
  return rowsOf<T>(await withConnectionRetry(() => execute(db, query)));
}

/**
 * Run a non-idempotent write and return its rows. Never retried
 * (issue #609): a connection dropped after the commit would replay it
 * and turn a success into `email_taken`, "token already consumed" or a
 * second credentials bump. The error surfaces instead.
 */
export async function writeRows<T>(db: AthlyaDbAny, query: SQL): Promise<T[]> {
  return rowsOf<T>(await execute(db, query));
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

/**
 * RFC 9562 UUID v7 (48-bit ms timestamp + random), matching the
 * `gen_uuid_v7()` column default so ids chosen by the app keep the same
 * index locality as ids chosen by Postgres.
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const serviceFn = {
  findActiveUserByEmail: (email: string) =>
    sql`SELECT * FROM auth_find_active_user_by_email(${email})`,
  findUserById: (id: string) => sql`SELECT * FROM auth_find_user_by_id(${id}::uuid)`,
  findStudioBySlug: (slug: string) => sql`SELECT * FROM auth_find_studio_by_slug(${slug})`,
  studioIdBySlug: (slug: string) => sql`SELECT studio_id_by_slug(${slug}) AS id`,
  createMember: (input: {
    studioId: string;
    email: string;
    displayName: string;
    passwordHash: string | null;
    consents: unknown;
  }) =>
    sql`SELECT * FROM auth_create_member(${input.studioId}::uuid, ${input.email}, ${input.displayName}, ${input.passwordHash}, ${JSON.stringify(input.consents)}::jsonb)`,
  createMemberWithEvent: (input: {
    userId: string;
    studioId: string;
    email: string;
    displayName: string;
    passwordHash: string | null;
    consents: unknown;
    event: unknown;
  }) =>
    sql`SELECT * FROM auth_create_member_with_event(${input.userId}::uuid, ${input.studioId}::uuid, ${input.email}, ${input.displayName}, ${input.passwordHash}, ${JSON.stringify(input.consents)}::jsonb, ${JSON.stringify(input.event)}::jsonb)`,
  softDeleteUser: (id: string) => sql`SELECT auth_soft_delete_user(${id}::uuid)`,
  softDeleteUserWithEvent: (id: string, event: unknown) =>
    sql`SELECT auth_soft_delete_user_with_event(${id}::uuid, ${JSON.stringify(event)}::jsonb)`,
  recordAuthEvent: (event: unknown) =>
    sql`SELECT auth_record_event(${JSON.stringify(event)}::jsonb)`,
  bumpCredentialsVersion: (id: string) => sql`SELECT auth_bump_credentials_version(${id}::uuid)`,
  requestPasswordReset: (email: string, eventId: string) =>
    sql`SELECT auth_request_password_reset(${email}, ${eventId}::uuid) AS enqueued`,
  issuePasswordResetForRequest: (userId: string, tokenHash: string, expiresAt: Date) =>
    sql`SELECT auth_issue_password_reset_for_request(${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz) AS outcome`,
  issuePasswordReset: (userId: string, tokenHash: string, expiresAt: Date) =>
    sql`SELECT auth_issue_password_reset(${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz) AS issued`,
  findPasswordReset: (tokenHash: string) =>
    sql`SELECT * FROM auth_find_password_reset(${tokenHash})`,
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
  deleteProgramSubscriptions: (userId: string) =>
    sql`SELECT rgpd_delete_program_subscriptions(${userId}::uuid) AS n`,
  anonymizeUserAudit: (userId: string) =>
    sql`SELECT rgpd_anonymize_user_audit(${userId}::uuid) AS n`,
  confirmUserDeleted: (userId: string) =>
    sql`SELECT rgpd_confirm_user_deleted(${userId}::uuid) AS deleted`,
} as const;
