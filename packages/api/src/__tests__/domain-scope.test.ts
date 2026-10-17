import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const assertRlsRole = vi.fn<(url: string, env: string) => Promise<void>>();

vi.mock('@athlya/db/client', () => ({
  assertRlsRole: (url: string, env: string) => assertRlsRole(url, env),
}));

const { installDomainScope } = await import('../domain-scope.js');
const { defaultAuthDeps, lazyAuthDeps } = await import('../domain-deps.js');

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
  // Typed as Required<AuthDeps>: adding a key to AuthDeps fails the
  // typecheck here until the test (and the facade) cover it.
  const full: Required<AuthDeps> = {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    deleteMe: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    checkRefreshRateLimit: vi.fn(() => Promise.resolve({ allow: true })),
    checkPasswordResetRateLimit: vi.fn(() => Promise.resolve(true)),
    idempotency: { db: {} as Required<AuthDeps>['idempotency']['db'] },
  };

  it.each(Object.keys(full))('forwards %s', (key) => {
    const deps = lazyAuthDeps(() => full);
    expect(deps[key as keyof AuthDeps]).toBeDefined();
  });

  it('forwards the optional rate limits and the idempotency db handle', async () => {
    const deps = lazyAuthDeps(() => full);

    await deps.checkPasswordResetRateLimit?.('a@example.com');
    await deps.checkRefreshRateLimit?.('token');

    expect(full.checkPasswordResetRateLimit).toHaveBeenCalledWith('a@example.com');
    expect(full.checkRefreshRateLimit).toHaveBeenCalledWith('token');
    expect(deps.idempotency?.db).toBe(full.idempotency.db);
  });

  it('exposes the idempotency facade before any env is resolved', () => {
    const resolve = vi.fn((): AuthDeps => full);
    const deps = lazyAuthDeps(resolve);

    expect(deps.idempotency).toBeDefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports an absent optional rate limit as undefined', () => {
    const { checkPasswordResetRateLimit: _omit, ...partial } = full;
    const deps = lazyAuthDeps(() => partial);

    expect(deps.checkPasswordResetRateLimit).toBeUndefined();
  });

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

describe('defaultAuthDeps signing-key guard', () => {
  it.each(['staging', 'production'] as const)('requires the PEM key pair on %s', (environment) => {
    const env = buildMockEnv({ ENVIRONMENT: environment });
    expect(() => defaultAuthDeps(env)).toThrow(/JWT_PRIVATE_KEY_PEM, JWT_PUBLIC_KEY_PEM/);
  });

  it('does not require the key pair in dev', () => {
    const env = buildMockEnv({ ENVIRONMENT: 'dev' });
    expect(() => defaultAuthDeps(env)).not.toThrow();
  });
});
