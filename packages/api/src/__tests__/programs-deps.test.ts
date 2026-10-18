import { describe, expect, it, vi } from 'vitest';

import { defaultProgramsDeps, lazyProgramsDeps } from '../domain-deps.js';

import { buildMockEnv } from './helpers/test-app.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { ProgramsDeps } from '../routes/programs.js';

const claims: AuthClaims = {
  userId: '11111111-1111-4111-8111-111111111111',
  studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'member',
};

describe('defaultProgramsDeps', () => {
  it('falls back to the stub bundle without DB_URL', () => {
    const deps = defaultProgramsDeps(buildMockEnv({ DB_URL: '' }));
    expect(() => deps.getToday(claims, undefined)).toThrow(/programs.getToday/u);
    expect(deps.idempotencyFor).toBeUndefined();
  });

  it('wires a tenant-scoped idempotency store with DB_URL', () => {
    const deps = defaultProgramsDeps(
      buildMockEnv({ DB_URL: 'postgres://athlya_app:pw@db.example.test/athlya' }),
    );
    const store = deps.idempotencyFor?.(claims);
    expect(typeof store?.db.execute).toBe('function');
  });
});

describe('lazyProgramsDeps', () => {
  it('resolves the bundle per call and forwards the arguments', async () => {
    const getToday = vi.fn().mockResolvedValue({ date: '2026-10-18', items: [] });
    const resolve = vi.fn(() => ({ getToday }) as unknown as ProgramsDeps);
    const lazy = lazyProgramsDeps(resolve);
    expect(resolve).not.toHaveBeenCalled();
    await expect(lazy.getToday(claims, '2026-10-18')).resolves.toEqual({
      date: '2026-10-18',
      items: [],
    });
    expect(getToday).toHaveBeenCalledWith(claims, '2026-10-18');
  });

  it('degrades to no idempotency store when the bundle has none', () => {
    const lazy = lazyProgramsDeps(() => ({}) as ProgramsDeps);
    expect(lazy.idempotencyFor?.(claims)).toBeUndefined();
  });
});
