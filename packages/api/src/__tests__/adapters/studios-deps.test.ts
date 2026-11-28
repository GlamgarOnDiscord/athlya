import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStudiosDeps, DOMAIN_CHECK_COOLDOWN_MS } from '../../adapters/studios-deps.js';
import {
  CUSTOM_DOMAIN_CNAME_TARGET,
  StudioDomainCheckCooldownError,
} from '../../white-label/dns-records.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { AthlyaBindings } from '../../types.js';

const repo = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  saveCheck: vi.fn(),
}));
const studioRepo = vi.hoisted(() => ({ getById: vi.fn(), updateById: vi.fn() }));

vi.mock('../../adapters/deps-cache.js', () => ({ getOrCreateDbHttp: () => ({}) }));
vi.mock('../../adapters/studio-domains-repo-drizzle.js', () => ({
  createDrizzleStudioDomainsRepoHttp: () => repo,
}));
vi.mock('../../adapters/studios-repo-drizzle.js', () => ({
  createDrizzleStudioRepoHttp: () => studioRepo,
}));

const claims = {
  userId: '11111111-1111-4111-8111-111111111113',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'admin',
} as AuthClaims;
const env = { DB_URL: 'postgres://unused' } as AthlyaBindings;
const NOW = Date.parse('2026-10-21T10:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'web',
    hostname: 'club.example.com',
    verificationToken: 'b'.repeat(32),
    status: 'pending',
    dnsChecks: null,
    dkimRecord: null,
    lastCheckedAt: null,
    verifiedAt: null,
    activatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildStudiosDeps: domains', () => {
  it('keeps the row and its token when the same hostname is submitted again', async () => {
    repo.get.mockResolvedValue(row());
    const deps = buildStudiosDeps(env, { lookup: vi.fn(), now: () => NOW });
    const view = await deps.setDomain('web', 'club.example.com', claims);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(view.records[1]?.value).toBe(`athlya-verification=${'b'.repeat(32)}`);
  });

  it('issues a fresh 128-bit token for a new hostname', async () => {
    repo.get.mockResolvedValue(row());
    repo.upsert.mockImplementation(async (_kind, hostname: string, token: string) =>
      row({ hostname, verificationToken: token }),
    );
    const deps = buildStudiosDeps(env, { lookup: vi.fn(), now: () => NOW });
    await deps.setDomain('web', 'app.example.com', claims);
    const token = repo.upsert.mock.calls[0]?.[2] as string;
    expect(token).toMatch(/^[a-f0-9]{32}$/u);
    expect(token).not.toBe('b'.repeat(32));
  });

  it('refuses a check inside the cooldown, with the seconds left', async () => {
    repo.get.mockResolvedValue(row({ lastCheckedAt: new Date(NOW - 4_000) }));
    const lookup = vi.fn();
    const deps = buildStudiosDeps(env, { lookup, now: () => NOW });
    const err = await deps.checkDomain('web', claims).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioDomainCheckCooldownError);
    expect((err as StudioDomainCheckCooldownError).retryAfterSeconds).toBe(
      (DOMAIN_CHECK_COOLDOWN_MS - 4_000) / 1000,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks the records up and saves a verified verdict', async () => {
    repo.get.mockResolvedValue(row({ lastCheckedAt: new Date(NOW - 60_000) }));
    repo.saveCheck.mockImplementation(async (_kind, write: { status: string; checks: unknown }) =>
      row({ status: write.status, dnsChecks: write.checks, lastCheckedAt: new Date(NOW) }),
    );
    const lookup = vi.fn(async (_name: string, type: string) =>
      type === 'CNAME' ? [CUSTOM_DOMAIN_CNAME_TARGET] : [`athlya-verification=${'b'.repeat(32)}`],
    );
    const deps = buildStudiosDeps(env, { lookup, now: () => NOW });
    const view = await deps.checkDomain('web', claims);
    expect(repo.saveCheck).toHaveBeenCalledWith('web', {
      status: 'verified',
      checks: [
        { purpose: 'routing', check: 'ok' },
        { purpose: 'ownership', check: 'ok' },
      ],
      checkedAt: new Date(NOW),
    });
    expect(view?.status).toBe('verified');
    expect(view?.records.every((r) => r.check === 'ok')).toBe(true);
  });

  it('returns null when the studio has no domain of that kind', async () => {
    repo.get.mockResolvedValue(null);
    const deps = buildStudiosDeps(env, { lookup: vi.fn(), now: () => NOW });
    await expect(deps.checkDomain('email', claims)).resolves.toBeNull();
  });
});

describe('buildStudiosDeps: logos', () => {
  it('saves an uploaded logo inline when no bucket is configured', async () => {
    studioRepo.updateById.mockResolvedValue({ id: claims.studioId });
    const deps = buildStudiosDeps(env, { lookup: vi.fn(), now: () => NOW });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    await deps.uploadLogo('dark', 'image/png', png, claims);
    expect(studioRepo.updateById).toHaveBeenCalledWith(claims.studioId, {
      brandLogoDark: 'data:image/png;base64,iVBORw==',
    });
  });

  it('clears the logo column on removal', async () => {
    studioRepo.updateById.mockResolvedValue({ id: claims.studioId });
    const deps = buildStudiosDeps(env, { lookup: vi.fn(), now: () => NOW });
    await deps.removeLogo('light', claims);
    expect(studioRepo.updateById).toHaveBeenCalledWith(claims.studioId, { brandLogoLight: null });
  });
});
