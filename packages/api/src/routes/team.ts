/**
 * `/v1/studios/me/team/*`: the studio team (issue #756).
 *
 *   | Method | Path                  | Chain                                                     |
 *   |--------|-----------------------|-----------------------------------------------------------|
 *   | GET    | /                     | jwtAuth → requireCapability('team.read') → handler        |
 *   | POST   | /invitations          | jwtAuth → requireCapability('team.manage') → zValidator → handler |
 *   | DELETE | /invitations/:id      | jwtAuth → requireCapability('team.manage') → zValidator → handler |
 *   | PATCH  | /members/:id          | jwtAuth → requireCapability('team.manage') → zValidator ×2 → handler |
 *   | POST   | /invitations/accept   | jwtAuth → zValidator → handler (any signed-in account)    |
 *
 * Mounted under the studios prefix so it reaches the same Worker as
 * `/v1/studios/*` without a new route pattern.
 *
 * The invitation token is 32 random bytes (base64url). Only its SHA-256
 * digest reaches the database (`team_invite`, migration 0052); the token
 * itself is in the 201 response, once, for the admin to share. That is
 * also why these mutations carry no idempotency replay: a replay store
 * would keep the token in `idempotency_keys`. Each one is safe to repeat:
 * a new invitation replaces the pending one, a role change or a
 * revocation applied twice ends in the same state.
 *
 * Every write runs through a SECURITY DEFINER function that re-checks the
 * caller's role, so the capability gate here is the first of two.
 */

import {
  AcceptInvitationRequestSchema,
  InviteTeamMemberRequestSchema,
  TeamInvitationParamsSchema,
  TeamMemberParamsSchema,
  UpdateTeamMemberRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, requireCapability, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type {
  AcceptInvitationRequest,
  InviteTeamMemberRequest,
  TeamInvitation,
  TeamInvitationParams,
  TeamMember,
  TeamMemberParams,
  TeamResponse,
  UpdateTeamMemberRequest,
} from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/** How long an invitation stays valid. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TeamRole = UpdateTeamMemberRequest['role'];

export type InviteOutcome =
  | { readonly kind: 'role_updated'; readonly member: TeamMember }
  | { readonly kind: 'invited'; readonly invitation: TeamInvitation }
  | { readonly kind: 'own_role' };

export type RoleChangeOutcome =
  | { readonly kind: 'updated'; readonly member: TeamMember | null }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'own_role' };

export interface TeamDeps {
  listTeam(claims: AuthClaims): Promise<TeamResponse>;
  invite(
    claims: AuthClaims,
    input: InviteTeamMemberRequest & { readonly tokenHash: string; readonly expiresAt: Date },
  ): Promise<InviteOutcome>;
  revokeInvitation(claims: AuthClaims, invitationId: string): Promise<boolean>;
  setMemberRole(claims: AuthClaims, userId: string, role: TeamRole): Promise<RoleChangeOutcome>;
  /** The granted role, or `null` when the token does not open an invitation for the caller. */
  acceptInvitation(claims: AuthClaims, tokenHash: string): Promise<TeamMember['role'] | null>;
}

/** 32 random bytes, base64url without padding (43 characters). */
export function newInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** SHA-256 of the token, lowercase hex: what the database stores. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PROBLEM_JSON = 'application/problem+json';

function problem(c: Context<HonoEnv>, status: 404 | 409, code: string, detail: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: status === 404 ? 'Not Found' : 'Conflict',
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status,
    { 'content-type': PROBLEM_JSON },
  );
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

export function buildTeamRouter(deps: TeamDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/', requireCapability('team.read'), async (c) => {
    traceOperation(c, 'team.list');
    const team = await deps.listTeam(claimsOf(c));
    return c.json(team, 200, { 'cache-control': 'private, no-store' });
  });

  router.post(
    '/invitations/accept',
    zValidator('json', AcceptInvitationRequestSchema),
    async (c) => {
      traceOperation(c, 'team.invitations.accept');
      const { token } = readValidated<AcceptInvitationRequest>(c, 'json');
      const role = await deps.acceptInvitation(claimsOf(c), await hashInvitationToken(token));
      if (role === null) {
        return problem(
          c,
          404,
          'invitation_not_found',
          'no pending invitation matches this token and account',
        );
      }
      return c.json({ role }, 200);
    },
  );

  router.post(
    '/invitations',
    requireCapability('team.manage'),
    zValidator('json', InviteTeamMemberRequestSchema),
    async (c) => {
      traceOperation(c, 'team.invitations.create');
      const body = readValidated<InviteTeamMemberRequest>(c, 'json');
      const token = newInvitationToken();
      const outcome = await deps.invite(claimsOf(c), {
        ...body,
        tokenHash: await hashInvitationToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
      if (outcome.kind === 'own_role') {
        return problem(c, 409, 'cannot_change_own_role', 'an admin cannot change their own role');
      }
      if (outcome.kind === 'role_updated') {
        return c.json({ outcome: 'role_updated', member: outcome.member }, 200);
      }
      return c.json({ outcome: 'invited', invitation: outcome.invitation, token }, 201, {
        'cache-control': 'no-store',
      });
    },
  );

  router.delete(
    '/invitations/:id',
    requireCapability('team.manage'),
    zValidator('param', TeamInvitationParamsSchema),
    async (c) => {
      traceOperation(c, 'team.invitations.revoke');
      const { id } = readValidated<TeamInvitationParams>(c, 'param');
      const revoked = await deps.revokeInvitation(claimsOf(c), id);
      if (!revoked) {
        return problem(c, 404, 'invitation_not_found', `no pending invitation ${id}`);
      }
      return c.body(null, 204);
    },
  );

  router.patch(
    '/members/:id',
    requireCapability('team.manage'),
    zValidator('param', TeamMemberParamsSchema),
    zValidator('json', UpdateTeamMemberRequestSchema),
    async (c) => {
      traceOperation(c, 'team.members.update');
      const { id } = readValidated<TeamMemberParams>(c, 'param');
      const { role } = readValidated<UpdateTeamMemberRequest>(c, 'json');
      const outcome = await deps.setMemberRole(claimsOf(c), id, role);
      if (outcome.kind === 'own_role') {
        return problem(c, 409, 'cannot_change_own_role', 'an admin cannot change their own role');
      }
      if (outcome.kind === 'not_found') {
        return problem(c, 404, 'member_not_found', `no account ${id} in this studio`);
      }
      return outcome.member === null ? c.body(null, 204) : c.json({ member: outcome.member }, 200);
    },
  );

  return router;
}
