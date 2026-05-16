/**
 * PostgreSQL enum types for the Athlya schema.
 *
 * Centralising them here — rather than inlining `pgEnum` next to each
 * table — lets every table that references an enum import from the same
 * source, and makes it impossible to drift between the Zod schemas
 * (`packages/shared/src/schemas/primitives.ts`) and the database.
 *
 * The label lists below MUST match the Zod enum definitions. Compile-time
 * checks at the bottom of the file fail to compile if they drift.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

import type { Reservation, User } from '@athlya/shared/schemas/domain';

/**
 * Roles used by RBAC and the `app.role` RLS session variable.
 * Matches `RoleSchema` in `@athlya/shared/schemas/primitives`.
 */
export const userRoleEnum = pgEnum('user_role', ['member', 'coach', 'admin']);

/**
 * Reservation state-machine labels. Transitions between labels are
 * enforced in code by `packages/reservations/src/state-machine.ts`
 * (task 6.6), not by the database, because the legal graph is not a total
 * order and PostgreSQL check constraints cannot express the predecessor
 * relation efficiently.
 *
 * Matches `ReservationStatusSchema` in `@athlya/shared/schemas/primitives`.
 */
export const reservationStatusEnum = pgEnum('reservation_status', [
    'confirmed',
    'waitlist',
    'cancelled',
    'no_show',
]);

/**
 * Platforms recognised by the push-notification routing layer.
 * Kept narrow on purpose — any new platform must be added deliberately so
 * the Notifications consumer (task 9.5) can gain a dedicated code path.
 */
export const pushPlatformEnum = pgEnum('push_platform', ['ios', 'android', 'web']);

/**
 * RGPD export job lifecycle. State transitions happen in
 * `packages/members/src/export.ts` (task 5.3):
 *
 *   - `pending`   — row created by `enqueueExport`; the QStash message
 *                   carrying `members.export.requested` has been (or is
 *                   about to be) published.
 *   - `running`   — the background worker claimed the job and started
 *                   streaming data sources into the ZIP archive.
 *   - `completed` — archive was uploaded to R2 and a signed URL (72 h
 *                   TTL) was persisted; `members.export.completed` is
 *                   emitted.
 *   - `failed`    — the worker caught an error it could not recover
 *                   from; the `error` column stores a short human-
 *                   readable reason.
 *
 * A job is terminal in `completed` / `failed`. The deduplication guard
 * in `enqueueExport` re-uses any row whose status is `pending` or
 * `running` for the same user (Requirement 4.3 keeps "one active
 * export at a time" implicit).
 */
export const exportJobStatusEnum = pgEnum('export_job_status', [
    'pending',
    'running',
    'completed',
    'failed',
]);

/* ------------------------------------------------------------------ */
/*  Compile-time drift guards                                           */
/* ------------------------------------------------------------------ */

/**
 * If the Zod-inferred `User.role` ever drifts from the enum literal list
 * above, these type checks fail to compile and the build breaks. They
 * have zero runtime cost.
 */
type _RoleAligned = User['role'] extends 'member' | 'coach' | 'admin'
    ? 'member' | 'coach' | 'admin' extends User['role']
    ? true
    : false
    : false;
type _StatusAligned = Reservation['status'] extends
    | 'confirmed'
    | 'waitlist'
    | 'cancelled'
    | 'no_show'
    ? 'confirmed' | 'waitlist' | 'cancelled' | 'no_show' extends Reservation['status']
    ? true
    : false
    : false;

const _roleOk: _RoleAligned = true;
const _statusOk: _StatusAligned = true;

void _roleOk;
void _statusOk;
