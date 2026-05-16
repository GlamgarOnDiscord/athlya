/**
 * Unit tests for `@athlya/members/service`.
 *
 * Covers the three use cases added in task 5.1:
 *   - `getProfile`  — Requirement 3.1.
 *   - `updateProfile` — Requirement 3.2 (whitelist) + 3.4 (displayName
 *     length bounds [1, 80]).
 *   - `listMembersByStudio` — Requirement 3.5 (admin/coach role gate).
 *
 * The repo is a hand-rolled `vi.fn()` triple so the tests never touch
 * Drizzle or a real Postgres — they exercise the service layer in
 * pure isolation, which is precisely what task 5.1 calls for.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  getProfile,
  listMembersByStudio,
  MembersError,
  updateProfile,
  type MemberProfile,
  type MemberRepo,
  type MembersPage,
  type MembersServiceDeps,
} from '../service.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';

const BASE_PROFILE: MemberProfile = {
  id: USER_ID,
  studioId: STUDIO_ID,
  email: 'member@example.test',
  displayName: 'Karim',
  avatarUrl: null,
  role: 'member',
  consents: {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: '2026-01',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Build a fresh `MembersServiceDeps` with `vi.fn()` repo doubles. */
function buildDeps(): {
  deps: MembersServiceDeps;
  findProfile: Mock<MemberRepo['findProfile']>;
  updateProfile: Mock<MemberRepo['updateProfile']>;
  listByStudio: Mock<MemberRepo['listByStudio']>;
} {
  const findProfile = vi.fn<MemberRepo['findProfile']>();
  const updateProfileFn = vi.fn<MemberRepo['updateProfile']>();
  const listByStudio = vi.fn<MemberRepo['listByStudio']>();

  const repo: MemberRepo = {
    findProfile,
    updateProfile: updateProfileFn,
    listByStudio,
  };

  return {
    deps: { repo },
    findProfile,
    updateProfile: updateProfileFn,
    listByStudio,
  };
}

/* ------------------------------------------------------------------ */
/*  getProfile                                                         */
/* ------------------------------------------------------------------ */

describe('getProfile', () => {
  it('returns the profile when the repo finds one', async () => {
    const { deps, findProfile } = buildDeps();
    findProfile.mockResolvedValueOnce(BASE_PROFILE);

    const result = await getProfile(USER_ID, deps);

    expect(result).toEqual(BASE_PROFILE);
    expect(findProfile).toHaveBeenCalledExactlyOnceWith(USER_ID);
  });

  it('throws MembersError(not_found) when the repo returns null', async () => {
    const { deps, findProfile } = buildDeps();
    findProfile.mockResolvedValueOnce(null);

    await expect(getProfile(USER_ID, deps)).rejects.toMatchObject({
      name: 'MembersError',
      code: 'not_found',
    });
  });

  it('preserves the MembersError instanceof check', async () => {
    const { deps, findProfile } = buildDeps();
    findProfile.mockResolvedValueOnce(null);

    await expect(getProfile(USER_ID, deps)).rejects.toBeInstanceOf(MembersError);
  });
});

/* ------------------------------------------------------------------ */
/*  updateProfile                                                      */
/* ------------------------------------------------------------------ */

describe('updateProfile', () => {
  it('persists a valid displayName + avatarUrl patch through the repo', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();
    const updated: MemberProfile = {
      ...BASE_PROFILE,
      displayName: 'Karim B.',
      avatarUrl: 'https://cdn.athlya.test/avatars/karim.png',
    };
    repoUpdate.mockResolvedValueOnce(updated);

    const result = await updateProfile(
      USER_ID,
      {
        displayName: 'Karim B.',
        avatarUrl: 'https://cdn.athlya.test/avatars/karim.png',
      },
      deps,
    );

    expect(result).toEqual(updated);
    expect(repoUpdate).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      displayName: 'Karim B.',
      avatarUrl: 'https://cdn.athlya.test/avatars/karim.png',
    });
  });

  it('allows a nullable avatarUrl (explicit clear)', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();
    repoUpdate.mockResolvedValueOnce({ ...BASE_PROFILE, avatarUrl: null });

    await updateProfile(USER_ID, { avatarUrl: null }, deps);

    expect(repoUpdate).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      avatarUrl: null,
    });
  });

  it('rejects an empty displayName with validation_failed at path [displayName]', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();

    const err = await updateProfile(USER_ID, { displayName: '' }, deps).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MembersError);
    expect(err).toMatchObject({
      code: 'validation_failed',
    });
    const membersErr = err as MembersError;
    expect(membersErr.issues).toBeDefined();
    expect(membersErr.issues?.some((i) => i.path === 'displayName')).toBe(true);
    // The repo must never be called on a validation failure.
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only displayName (trimmed length is zero)', async () => {
    const { deps } = buildDeps();

    const err = await updateProfile(USER_ID, { displayName: '   ' }, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect((err as MembersError).issues?.some((i) => i.path === 'displayName')).toBe(true);
  });

  it('rejects a displayName longer than 80 characters', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();

    const tooLong = 'x'.repeat(81);
    const err = await updateProfile(USER_ID, { displayName: tooLong }, deps).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect((err as MembersError).issues?.some((i) => i.path === 'displayName')).toBe(true);
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it('accepts a displayName at exactly the 80-char boundary', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();
    const boundary = 'y'.repeat(80);
    repoUpdate.mockResolvedValueOnce({
      ...BASE_PROFILE,
      displayName: boundary,
    });

    await updateProfile(USER_ID, { displayName: boundary }, deps);

    expect(repoUpdate).toHaveBeenCalledExactlyOnceWith(USER_ID, {
      displayName: boundary,
    });
  });

  it('rejects unknown fields (whitelist — role cannot be escalated)', async () => {
    const { deps, updateProfile: repoUpdate } = buildDeps();

    const err = await updateProfile(USER_ID, { displayName: 'Karim', role: 'admin' }, deps).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it('rejects an empty patch (no fields to update)', async () => {
    const { deps } = buildDeps();

    const err = await updateProfile(USER_ID, {}, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('validation_failed');
  });

  it('rejects a non-object payload (null, array, primitive)', async () => {
    const { deps } = buildDeps();

    for (const bad of [null, 'oops', 42, [], true]) {
      const err = await updateProfile(USER_ID, bad, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MembersError);
      expect((err as MembersError).code).toBe('validation_failed');
    }
  });
});

/* ------------------------------------------------------------------ */
/*  listMembersByStudio                                                */
/* ------------------------------------------------------------------ */

describe('listMembersByStudio', () => {
  const page: MembersPage = {
    items: [BASE_PROFILE],
    nextCursor: null,
  };

  it('forbids a member from listing studio profiles', async () => {
    const { deps, listByStudio } = buildDeps();

    const err = await listMembersByStudio(STUDIO_ID, 'member', {}, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MembersError);
    expect((err as MembersError).code).toBe('forbidden');
    expect(listByStudio).not.toHaveBeenCalled();
  });

  it('allows an admin to list members of their studio', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    const result = await listMembersByStudio(STUDIO_ID, 'admin', {}, deps);

    expect(result).toBe(page);
    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 20,
    });
  });

  it('allows a coach to list members of their studio', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    await listMembersByStudio(STUDIO_ID, 'coach', {}, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 20,
    });
  });

  it('passes the opaque cursor through when provided', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce({ items: [], nextCursor: null });

    await listMembersByStudio(STUDIO_ID, 'admin', { cursor: 'opaque-cursor', limit: 50 }, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      cursor: 'opaque-cursor',
      limit: 50,
    });
  });

  it('clamps a limit below 1 to the minimum', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    await listMembersByStudio(STUDIO_ID, 'admin', { limit: 0 }, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 1,
    });
  });

  it('clamps a limit above 100 to the maximum', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    await listMembersByStudio(STUDIO_ID, 'admin', { limit: 5000 }, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 100,
    });
  });

  it('substitutes the default limit when the caller omits it', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    await listMembersByStudio(STUDIO_ID, 'admin', {}, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 20,
    });
  });

  it('ignores non-integer / NaN limits by falling back to the default', async () => {
    const { deps, listByStudio } = buildDeps();
    listByStudio.mockResolvedValueOnce(page);

    await listMembersByStudio(STUDIO_ID, 'admin', { limit: Number.NaN }, deps);

    expect(listByStudio).toHaveBeenCalledExactlyOnceWith(STUDIO_ID, {
      limit: 20,
    });
  });
});
