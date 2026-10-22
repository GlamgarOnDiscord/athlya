/**
 * Team adapter (issue #756): wires {@link TeamDeps} to PostgreSQL.
 *
 * Reads run under the caller's claims (RLS): `users_read_same_studio`
 * admits staff, `studio_invitations_read_managers` admins and managers.
 * Writes call the SECURITY DEFINER team functions of migration 0052,
 * which re-check that the caller is an admin of the studio, refuse a
 * change of the caller's own role, and bump the target's
 * `credentials_version`.
 */

import { withTenant } from '@athlya/db/client';
import { isPostgresRaiseException } from '@athlya/db/errors';
import { studioInvitations, users } from '@athlya/db/schema';
import { STAFF_ROLES, isStaffRole } from '@athlya/shared/roles';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import { getOrCreateWriteDb } from './deps-cache.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { InviteOutcome, RoleChangeOutcome, TeamDeps } from '../routes/team.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDb, AthlyaTx, TenantClaims } from '@athlya/db/client';
import type { TeamInvitation, TeamMember } from '@athlya/shared/schemas/api';

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

const memberColumns = {
  id: users.id,
  displayName: users.displayName,
  email: users.email,
  avatarUrl: users.avatarUrl,
  role: users.role,
  createdAt: users.createdAt,
};

type MemberRow = {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  role: string;
  createdAt: Date;
};

function toMember(row: MemberRow): TeamMember | null {
  if (!isStaffRole(row.role)) return null;
  return {
    id: row.id as TeamMember['id'],
    displayName: row.displayName,
    email: row.email,
    avatarUrl: row.avatarUrl,
    role: row.role,
    joinedAt: iso(row.createdAt),
  };
}

async function readMember(tx: AthlyaTx, userId: string): Promise<TeamMember | null> {
  const [row] = await tx
    .select(memberColumns)
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return row === undefined ? null : toMember(row);
}

/** Team repository over a postgres-js handle; exported for the PGlite tests. */
export function createTeamRepo(db: AthlyaDb): TeamDeps {
  return {
    async listTeam(claims) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const memberRows = await tx
          .select(memberColumns)
          .from(users)
          .where(
            and(
              eq(users.studioId, claims.studioId),
              isNull(users.deletedAt),
              inArray(users.role, [...STAFF_ROLES]),
            ),
          )
          .orderBy(asc(users.displayName), asc(users.id));
        const invitationRows = await tx
          .select({
            id: studioInvitations.id,
            email: studioInvitations.email,
            role: studioInvitations.role,
            createdAt: studioInvitations.createdAt,
            expiresAt: studioInvitations.expiresAt,
          })
          .from(studioInvitations)
          .where(
            and(
              eq(studioInvitations.studioId, claims.studioId),
              isNull(studioInvitations.acceptedAt),
              isNull(studioInvitations.revokedAt),
              gt(studioInvitations.expiresAt, sql`now()`),
            ),
          )
          .orderBy(asc(studioInvitations.createdAt), asc(studioInvitations.id));

        const members = memberRows
          .map(toMember)
          .filter((member): member is TeamMember => member !== null)
          .sort((a, b) => Number(b.id === claims.userId) - Number(a.id === claims.userId));
        const invitations = invitationRows.flatMap((row): TeamInvitation[] =>
          isStaffRole(row.role)
            ? [
                {
                  id: row.id,
                  email: row.email,
                  role: row.role,
                  invitedAt: iso(row.createdAt),
                  expiresAt: iso(row.expiresAt),
                },
              ]
            : [],
        );
        return { members, invitations };
      });
    },

    async invite(claims, input): Promise<InviteOutcome> {
      try {
        return await withTenant(db, toTenantClaims(claims), async (tx) => {
          const [row] = rowsOf(
            await tx.execute(
              sql`SELECT outcome, user_id, invitation_id FROM team_invite(${input.email}, ${input.role}, ${input.tokenHash}, ${input.expiresAt.toISOString()}::timestamptz)`,
            ),
          );
          if (row === undefined) throw new Error('team_invite returned no row');
          if (row['outcome'] === 'role_updated') {
            const member = await readMember(tx, String(row['user_id']));
            if (member === null) throw new Error('team_invite: updated account not readable');
            return { kind: 'role_updated', member };
          }
          return {
            kind: 'invited',
            invitation: {
              id: String(row['invitation_id']),
              email: input.email,
              role: input.role,
              invitedAt: new Date().toISOString(),
              expiresAt: input.expiresAt.toISOString(),
            },
          };
        });
      } catch (err) {
        if (isPostgresRaiseException(err, 'cannot_change_own_role')) return { kind: 'own_role' };
        throw err;
      }
    },

    async revokeInvitation(claims, invitationId) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const [row] = rowsOf(
          await tx.execute(sql`SELECT team_revoke_invitation(${invitationId}::uuid) AS revoked`),
        );
        return row?.['revoked'] === true;
      });
    },

    async setMemberRole(claims, userId, role): Promise<RoleChangeOutcome> {
      try {
        return await withTenant(db, toTenantClaims(claims), async (tx) => {
          const [row] = rowsOf(
            await tx.execute(sql`SELECT id FROM team_set_member_role(${userId}::uuid, ${role})`),
          );
          if (row === undefined) return { kind: 'not_found' };
          return {
            kind: 'updated',
            member: role === 'member' ? null : await readMember(tx, userId),
          };
        });
      } catch (err) {
        if (isPostgresRaiseException(err, 'cannot_change_own_role')) return { kind: 'own_role' };
        throw err;
      }
    },

    async acceptInvitation(claims, tokenHash) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const [row] = rowsOf(
          await tx.execute(
            sql`SELECT role::text AS role FROM team_accept_invitation(${tokenHash})`,
          ),
        );
        const role = row?.['role'];
        return isStaffRole(role) ? role : null;
      });
    },
  };
}

export function buildTeamDeps(env: AthlyaBindings): TeamDeps {
  const repo = (): TeamDeps => createTeamRepo(getOrCreateWriteDb(env));
  return {
    listTeam: (claims) => repo().listTeam(claims),
    invite: (claims, input) => repo().invite(claims, input),
    revokeInvitation: (claims, id) => repo().revokeInvitation(claims, id),
    setMemberRole: (claims, userId, role) => repo().setMemberRole(claims, userId, role),
    acceptInvitation: (claims, tokenHash) => repo().acceptInvitation(claims, tokenHash),
  };
}
