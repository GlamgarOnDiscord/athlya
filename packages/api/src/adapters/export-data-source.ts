/**
 * `MemberDataSource` for the RGPD export worker (issue #498).
 *
 * The queue consumer runs as `athlya_app` without tenant claims, so it
 * reads personal data only through the SECURITY DEFINER functions of
 * migration 0034. They take the claimed job id, not a user id: data is
 * returned only while that job is `running`, and only for its user.
 * Collections are paged with a keyset cursor so a long history never
 * sits in memory at once (issue #469).
 */

import { sql } from 'drizzle-orm';

import { queryRows } from './service-functions.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type {
  CheckinRecord,
  ExportProfile,
  InvoiceRecord,
  MemberDataSource,
} from '@athlya/members';
import type { Consents } from '@athlya/shared/schemas';
import type { AuditLog, Reservation, WorkoutSession } from '@athlya/shared/schemas/domain';

/** Raised when the job is not claimed (or belongs to another user). */
export const EXPORT_JOB_NOT_CLAIMED_REASON = 'export_job_not_claimed';

type Section = 'reservations' | 'checkins' | 'workout_sessions' | 'audit_trail';

interface ProfileRow extends ExportProfile {
  readonly consents: Consents;
}

export function createExportDataSource(db: AthlyaDbAny, pageSize = 200): MemberDataSource {
  async function profileOf(userId: string, jobId: string): Promise<ProfileRow> {
    const rows = await queryRows<{ profile: ProfileRow | null }>(
      db,
      sql`SELECT export_job_profile(${jobId}::uuid) AS profile`,
    );
    const profile = rows[0]?.profile ?? null;
    if (profile === null || profile.id !== userId) {
      throw new Error(EXPORT_JOB_NOT_CLAIMED_REASON);
    }
    return profile;
  }

  async function* pages<T>(jobId: string, section: Section): AsyncGenerator<ReadonlyArray<T>> {
    let after: string | null = null;
    for (;;) {
      const rows: Array<{ cursor: string; data: T }> = await queryRows(
        db,
        sql`SELECT cursor, data FROM export_job_rows(${jobId}::uuid, ${section}, ${after}, ${pageSize})`,
      );
      if (rows.length === 0) return;
      yield rows.map((r) => r.data);
      if (rows.length < pageSize) return;
      after = rows[rows.length - 1]!.cursor;
    }
  }

  return {
    async fetchProfile(userId, jobId) {
      const { consents: _consents, ...profile } = await profileOf(userId, jobId);
      return profile;
    },
    async fetchConsents(userId, jobId) {
      return [(await profileOf(userId, jobId)).consents];
    },
    listReservations: (_userId, jobId) => pages<Reservation>(jobId, 'reservations'),
    listSessions: (_userId, jobId) => pages<WorkoutSession>(jobId, 'workout_sessions'),
    listCheckins: (_userId, jobId) => pages<CheckinRecord>(jobId, 'checkins'),
    // No invoice is persisted yet: billing records live in Stripe until
    // the billing persistence of issue #122 lands. Empty, not failing, so
    // the rest of the member's data is still exportable.
    async *listInvoices(): AsyncGenerator<ReadonlyArray<InvoiceRecord>> {},
    listAuditTrail: (_userId, jobId) => pages<AuditLog>(jobId, 'audit_trail'),
  };
}
