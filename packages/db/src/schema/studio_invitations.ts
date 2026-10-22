/**
 * `studio_invitations`: pending invitations to a studio team (migration
 * 0052, issue #756).
 *
 * One pending row per studio and email (`studio_invitations_pending_unique`).
 * Rows are written by the SECURITY DEFINER team functions only
 * (`team_invite`, `team_revoke_invitation`, `team_accept_invitation`);
 * athlya_app reads them under the `studio_invitations_read_managers`
 * policy (admins and managers of the studio).
 *
 * The `token_hash` column (SHA-256 hex of the invitation token) is left
 * out of this table definition on purpose: athlya_app has no SELECT on it,
 * so a `select()` of the whole table must never name it.
 */

import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { uuidPrimaryKey } from './_shared.js';
import { userRoleEnum } from './enums.js';
import { studios } from './studios.js';
import { users } from './users.js';

export const studioInvitations = pgTable('studio_invitations', {
  id: uuidPrimaryKey(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id, { onDelete: 'cascade' }),
  /** `citext` in the database (case-insensitive match on acceptance). */
  email: text('email').notNull(),
  role: userRoleEnum('role').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
});

export type StudioInvitationRow = typeof studioInvitations.$inferSelect;
