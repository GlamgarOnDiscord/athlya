import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const assertRlsRole = vi.fn<(url: string, env: string) => Promise<void>>();

vi.mock('@athlya/db/client', () => ({
  assertRlsRole: (url: string, env: string) => assertRlsRole(url, env),
}));

const { installDomainScope } = await import('../domain-scope.js');
const { lazyAuthDeps } = await import('../domain-deps.js');

import { buildMockEnv } from './helpers/test-app.js';

import type { AuthDeps } from '../routes/auth.js';
import type { AthlyaBindings, HonoEnv } from '../types.js';

const ENV = buildMockEnv({
  ENVIRONMENT: 'dev',
  DB_URL: 'postgresql://app@db.example/athlya',
});

function buildScopedApp(build = vi.fn((env: AthlyaBindings) => env.ENVIRONMENT)) {
  const app = new Hono<HonoEnv>();
  const resolve = installDomainScope(app, 'test worker', build);
  app.get('/v1/ping', (c) => c.text(resolve()));
  return { app, build, resolve };
}

describe('installDomainScope', () => {
  beforeEach(() => {
    assertRlsRole.mockReset();
  });

  it('resolves through the caller-supplied builder with the captured env', async () => {
    assertRlsRole.mockResolvedValue(undefined);
    const { app, build } = buildScopedApp();

    const res = await app.request('/v1/ping', undefined, ENV);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('dev');
    expect(build).toHaveBeenCalledWith(ENV, undefined);
  });

  it('throws when resolved before any /v1/* request captured the env', () => {
    const { resolve } = buildScopedApp();
    expect(() => resolve()).toThrow(/test worker: request env not yet captured/);
  });

  it('runs the RLS role check once per isolate after it succeeds', async () => {
    assertRlsRole.mockResolvedValue(undefined);
    const { app } = buildScopedApp();

    await app.request('/v1/ping', undefined, ENV);
    await app.request('/v1/ping', undefined, ENV);

    expect(assertRlsRole).toHaveBeenCalledTimes(1);
  });

  it('retries the RLS role check after a transient failure', async () => {
    assertRlsRole.mockRejectedValueOnce(new Error('neon: fetch failed'));
    assertRlsRole.mockResolvedValue(undefined);
    const { app } = buildScopedApp();

    const first = await app.request('/v1/ping', undefined, ENV);
    const second = await app.request('/v1/ping', undefined, ENV);

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(assertRlsRole).toHaveBeenCalledTimes(2);
  });
});

describe('lazyAuthDeps', () => {
  it('resolves the bundle on each call and forwards the arguments', async () => {
    const logout = vi.fn(() => Promise.resolve());
    const resolve = vi.fn(() => ({ logout }) as unknown as AuthDeps);
    const deps = lazyAuthDeps(resolve);

    expect(resolve).not.toHaveBeenCalled();
    await deps.logout('user-1');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith('user-1');
  });
});
