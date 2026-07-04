/**
 * Unit tests for `PUT /v1/members/me/avatar` (N2.13 — R2 avatar upload).
 *
 * Covers:
 *   1. No Authorization header → 401.
 *   2. Unsupported Content-Type → 415 `unsupported_media_type`.
 *   3. Missing Content-Length → 411 `length_required`.
 *   4. Body exceeds 5 MB → 413 `avatar_too_large`.
 *   5. Empty body → 400 `empty_body`.
 *   6. `uploadAvatar` throws `AvatarUploadNotConfiguredError` → 503.
 *   7. Happy path (image/jpeg, 1 KB body) → 200 with `{ avatarUrl }`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarUploadNotConfiguredError } from '../../adapters/avatar-upload-store-r2.js';
import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';

import {
  buildLocalResolver,
  buildStubDeps,
  env,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';

const joseHoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (joseHoisted.localResolver === null) {
          throw new Error('local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mintJwt(role: 'member' | 'admin' = 'member'): Promise<string> {
  return signTestJwt(kp.privateKey, {
    sub: TEST_USER_ID,
    studio: TEST_STUDIO_ID,
    role,
  });
}

function buildAppWithDeps(deps: DomainDeps) {
  return buildApp({ deps });
}

const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;

describe('PUT /v1/members/me/avatar', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: TINY_JPEG,
      },
      env(),
    );

    expect(res.status).toBe(401);
    expect(deps.members.uploadAvatar).not.toHaveBeenCalled();
  });

  it('returns 415 for an unsupported Content-Type', async () => {
    const token = await mintJwt();
    const deps = buildStubDeps();
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/gif',
        },
        body: TINY_JPEG,
      },
      env(),
    );

    expect(res.status).toBe(415);
    const body = (await res.json()) as any;
    expect(body.code).toBe('unsupported_media_type');
    expect(deps.members.uploadAvatar).not.toHaveBeenCalled();
  });

  it('returns 411 when Content-Length is absent', async () => {
    const token = await mintJwt();
    const deps = buildStubDeps();
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/jpeg',
        },
        body: TINY_JPEG,
      },
      env(),
    );

    expect(res.status).toBe(411);
    const body = (await res.json()) as any;
    expect(body.code).toBe('length_required');
    expect(deps.members.uploadAvatar).not.toHaveBeenCalled();
  });

  it.each([
    ['abc', 'non-numeric string'],
    ['1e6', 'scientific notation'],
    ['10abc', 'partial numeric'],
    ['0x10', 'hex notation'],
    ['-1', 'negative value'],
  ])(
    'returns 400 invalid_content_length for malformed Content-Length "%s" (%s)',
    async (badValue) => {
      const token = await mintJwt();
      const deps = buildStubDeps();
      const app = buildAppWithDeps(deps);

      const res = await app.request(
        '/v1/members/me/avatar',
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'image/jpeg',
            'content-length': badValue,
          },
          body: TINY_JPEG,
        },
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.code).toBe('invalid_content_length');
      expect(deps.members.uploadAvatar).not.toHaveBeenCalled();
    },
  );

  it('returns 413 when body exceeds 5 MB', async () => {
    const token = await mintJwt();
    const deps = buildStubDeps();
    const app = buildAppWithDeps(deps);

    const bigBodySize = 5 * 1024 * 1024 + 1;
    const bigBody = new Uint8Array(bigBodySize).buffer;

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/png',
          'content-length': String(bigBodySize),
        },
        body: bigBody,
      },
      env(),
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.code).toBe('avatar_too_large');
  });

  it('returns 400 for an empty body', async () => {
    const token = await mintJwt();
    const deps = buildStubDeps();
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/webp',
          'content-length': '0',
        },
        body: new ArrayBuffer(0),
      },
      env(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe('empty_body');
  });

  it('returns 503 when uploadAvatar throws AvatarUploadNotConfiguredError', async () => {
    const token = await mintJwt();
    const deps = buildStubDeps({
      members: {
        uploadAvatar: vi
          .fn()
          .mockRejectedValue(new AvatarUploadNotConfiguredError('AVATARS_BUCKET not bound')),
      },
    });
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/jpeg',
          'content-length': String(TINY_JPEG.byteLength),
        },
        body: TINY_JPEG,
      },
      env(),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.code).toBe('avatar_upload_not_configured');
  });

  it('returns 200 with avatarUrl on happy path', async () => {
    const token = await mintJwt();
    const avatarUrl = 'https://avatars.athlya.app/avatars/u1/avatar.jpg';
    const deps = buildStubDeps({
      members: {
        uploadAvatar: vi.fn().mockResolvedValue({ avatarUrl }),
      },
    });
    const app = buildAppWithDeps(deps);

    const res = await app.request(
      '/v1/members/me/avatar',
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/jpeg',
          'content-length': String(TINY_JPEG.byteLength),
        },
        body: TINY_JPEG,
      },
      env(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.avatarUrl).toBe(avatarUrl);
    expect(deps.members.uploadAvatar).toHaveBeenCalledWith(
      TEST_USER_ID,
      'image/jpeg',
      expect.any(ArrayBuffer),
      expect.objectContaining({ userId: TEST_USER_ID }),
    );
  });
});
