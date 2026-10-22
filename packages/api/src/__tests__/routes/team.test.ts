/**
 * `/v1/studios/me/team/*` router (issue #756): the capability gate of
 * each route, the token handling of an invitation and the mapping of
 * the adapter outcomes to HTTP.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { hashInvitationToken, newInvitationToken } from '../../routes/team.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildStubDeps,
  env,
  mintAuthJwt,
  mintTestKeypair,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { TeamDeps } from '../../routes/team.js';
import type { Role } from '@athlya/shared/roles';
import type { TeamMember, TeamResponse } from '@athlya/shared/schemas/api';

const hoisted = vi.hoisted(() => ({ localResolver: null as JwksKeyResolver | null }));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (hoisted.localResolver === null) throw new Error('local resolver not initialised');
        return hoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const INVITATION_ID = '0d000000-0000-4000-8000-000000000001';

const MEMBER: TeamMember = {
  id: MEMBER_ID as TeamMember['id'],
  displayName: 'Inès Garnier',
  email: 'ines@example.test',
  avatarUrl: null,
  role: 'coach',
  joinedAt: '2026-10-01T08:00:00.000Z',
};

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  hoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function teamDeps(overrides: Partial<TeamDeps> = {}): TeamDeps {
  return {
    listTeam: vi
      .fn<TeamDeps['listTeam']>()
      .mockResolvedValue({ members: [MEMBER], invitations: [] }),
    invite: vi.fn<TeamDeps['invite']>(),
    revokeInvitation: vi.fn<TeamDeps['revokeInvitation']>().mockResolvedValue(true),
    setMemberRole: vi.fn<TeamDeps['setMemberRole']>(),
    acceptInvitation: vi.fn<TeamDeps['acceptInvitation']>(),
    ...overrides,
  };
}

async function call(
  team: TeamDeps,
  role: Role,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const app = buildApp({ deps: { ...buildStubDeps(), team } });
  const token = await mintAuthJwt(kp, { role });
  return app.request(
    `/v1/studios/me/team${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

describe('GET /v1/studios/me/team', () => {
  it.each<Role>(['admin', 'manager'])('serves the team to %s', async (role) => {
    const team = teamDeps();
    const res = await call(team, role, 'GET', '');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await readJson<TeamResponse>(res)).members).toEqual([MEMBER]);
    expect(team.listTeam).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID, role }),
    );
  });

  it.each<Role>(['accueil', 'coach', 'member'])('refuses %s with 403', async (role) => {
    const team = teamDeps();
    const res = await call(team, role, 'GET', '');

    expect(res.status).toBe(403);
    expect(team.listTeam).not.toHaveBeenCalled();
  });
});

describe('POST /v1/studios/me/team/invitations', () => {
  it('creates an invitation, stores only the digest and returns the token once', async () => {
    const team = teamDeps({
      invite: vi.fn<TeamDeps['invite']>().mockImplementation((_claims, input) =>
        Promise.resolve({
          kind: 'invited',
          invitation: {
            id: INVITATION_ID,
            email: input.email,
            role: input.role,
            invitedAt: '2026-10-21T08:00:00.000Z',
            expiresAt: input.expiresAt.toISOString(),
          },
        }),
      ),
    });

    const res = await call(team, 'admin', 'POST', '/invitations', {
      email: 'Lea@Example.TEST',
      role: 'accueil',
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await readJson<{ outcome: string; token: string }>(res);
    expect(body.outcome).toBe('invited');
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const input = vi.mocked(team.invite).mock.calls[0]?.[1];
    expect(input?.email).toBe('lea@example.test');
    expect(input?.tokenHash).toBe(await hashInvitationToken(body.token));
    expect(input?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
  });

  it('answers 200 with the member when the account already exists', async () => {
    const team = teamDeps({
      invite: vi
        .fn<TeamDeps['invite']>()
        .mockResolvedValue({ kind: 'role_updated', member: MEMBER }),
    });

    const res = await call(team, 'admin', 'POST', '/invitations', {
      email: 'ines@example.test',
      role: 'coach',
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ outcome: 'role_updated', member: MEMBER });
  });

  it('maps the own-role refusal to 409', async () => {
    const team = teamDeps({
      invite: vi.fn<TeamDeps['invite']>().mockResolvedValue({ kind: 'own_role' }),
    });

    const res = await call(team, 'admin', 'POST', '/invitations', {
      email: 'me@example.test',
      role: 'coach',
    });

    expect(res.status).toBe(409);
    expect((await readJson<{ code: string }>(res)).code).toBe('cannot_change_own_role');
  });

  it.each<Role>(['manager', 'accueil', 'coach', 'member'])('refuses %s with 403', async (role) => {
    const team = teamDeps();
    const res = await call(team, role, 'POST', '/invitations', {
      email: 'x@example.test',
      role: 'coach',
    });

    expect(res.status).toBe(403);
    expect(team.invite).not.toHaveBeenCalled();
  });

  it('rejects an invitation to the member role with 422', async () => {
    const team = teamDeps();
    const res = await call(team, 'admin', 'POST', '/invitations', {
      email: 'x@example.test',
      role: 'member',
    });

    expect(res.status).toBe(422);
    expect(team.invite).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/studios/me/team/members/:id', () => {
  it('returns the member with the new role', async () => {
    const team = teamDeps({
      setMemberRole: vi
        .fn<TeamDeps['setMemberRole']>()
        .mockResolvedValue({ kind: 'updated', member: { ...MEMBER, role: 'manager' } }),
    });

    const res = await call(team, 'admin', 'PATCH', `/members/${MEMBER_ID}`, { role: 'manager' });

    expect(res.status).toBe(200);
    expect(team.setMemberRole).toHaveBeenCalledWith(expect.anything(), MEMBER_ID, 'manager');
  });

  it('answers 204 when the account leaves the team', async () => {
    const team = teamDeps({
      setMemberRole: vi
        .fn<TeamDeps['setMemberRole']>()
        .mockResolvedValue({ kind: 'updated', member: null }),
    });

    const res = await call(team, 'admin', 'PATCH', `/members/${MEMBER_ID}`, { role: 'member' });

    expect(res.status).toBe(204);
  });

  it('maps not_found to 404 and own_role to 409', async () => {
    const setMemberRole = vi
      .fn<TeamDeps['setMemberRole']>()
      .mockResolvedValueOnce({ kind: 'not_found' })
      .mockResolvedValueOnce({ kind: 'own_role' });
    const team = teamDeps({ setMemberRole });

    expect(
      (await call(team, 'admin', 'PATCH', `/members/${MEMBER_ID}`, { role: 'coach' })).status,
    ).toBe(404);
    expect(
      (await call(team, 'admin', 'PATCH', `/members/${MEMBER_ID}`, { role: 'coach' })).status,
    ).toBe(409);
  });

  it('refuses a manager with 403', async () => {
    const team = teamDeps();
    const res = await call(team, 'manager', 'PATCH', `/members/${MEMBER_ID}`, { role: 'admin' });

    expect(res.status).toBe(403);
    expect(team.setMemberRole).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/studios/me/team/invitations/:id', () => {
  it('answers 204, then 404 when nothing was pending', async () => {
    const revokeInvitation = vi
      .fn<TeamDeps['revokeInvitation']>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const team = teamDeps({ revokeInvitation });

    expect((await call(team, 'admin', 'DELETE', `/invitations/${INVITATION_ID}`)).status).toBe(204);
    expect((await call(team, 'admin', 'DELETE', `/invitations/${INVITATION_ID}`)).status).toBe(404);
  });
});

describe('POST /v1/studios/me/team/invitations/accept', () => {
  it('lets a member accept with the digest of the token and returns the role', async () => {
    const token = newInvitationToken();
    const team = teamDeps({
      acceptInvitation: vi.fn<TeamDeps['acceptInvitation']>().mockResolvedValue('accueil'),
    });

    const res = await call(team, 'member', 'POST', '/invitations/accept', { token });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ role: 'accueil' });
    expect(team.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'member' }),
      await hashInvitationToken(token),
    );
  });

  it('answers 404 when the token opens nothing for this account', async () => {
    const team = teamDeps({
      acceptInvitation: vi.fn<TeamDeps['acceptInvitation']>().mockResolvedValue(null),
    });

    const res = await call(team, 'member', 'POST', '/invitations/accept', {
      token: newInvitationToken(),
    });

    expect(res.status).toBe(404);
    expect((await readJson<{ code: string }>(res)).code).toBe('invitation_not_found');
  });

  it('rejects a malformed token with 422', async () => {
    const team = teamDeps();
    const res = await call(team, 'member', 'POST', '/invitations/accept', { token: 'short' });

    expect(res.status).toBe(422);
    expect(team.acceptInvitation).not.toHaveBeenCalled();
  });
});

describe('invitation tokens', () => {
  it('are 43 base64url characters, distinct, with a 64-hex digest', async () => {
    const a = newInvitationToken();
    const b = newInvitationToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(a).not.toBe(b);
    expect(await hashInvitationToken(a)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
