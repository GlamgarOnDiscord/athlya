import { describe, it, expect, vi } from 'vitest';

import {
  buildPasswordResetEmailTransport,
  resolveResetLinkBaseUrl,
  resolveResetTokenDeriver,
} from '../../adapters/auth-deps.js';

import type { AthlyaBindings } from '../../types.js';

const TOKEN = 'test-reset-token';
const BASE_INPUT = {
  to: 'member@example.com',
  link: `https://athlya.app/reset-password/${TOKEN}`,
  expiresAt: new Date('2026-01-01T00:00:00Z'),
  idempotencyKey: 'password-reset/0193f000-0000-7000-8000-000000000645',
};

function makeEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return {
    ENVIRONMENT: 'dev',
    RESEND_API_KEY: undefined as unknown as string,
    RESEND_FROM: undefined as unknown as string,
    ...overrides,
  } as unknown as AthlyaBindings;
}

describe('buildPasswordResetEmailTransport', () => {
  describe('dev environment — no RESEND_API_KEY', () => {
    it('resolves without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'dev' }));
      await expect(transport.sendResetEmail(BASE_INPUT)).resolves.toBeUndefined();
      warnSpy.mockRestore();
    });

    it('warns without logging the reset link or the recipient (issue #645)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'dev' }));
      await transport.sendResetEmail(BASE_INPUT);
      expect(warnSpy).toHaveBeenCalledOnce();
      const logged = JSON.stringify(warnSpy.mock.calls[0]);
      expect(logged).not.toContain('reset-password');
      expect(logged).not.toContain(BASE_INPUT.link);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(BASE_INPUT.to);
      warnSpy.mockRestore();
    });
  });

  describe('staging environment — no RESEND_API_KEY', () => {
    it('rejects with a configuration error', async () => {
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'staging' }));
      await expect(transport.sendResetEmail(BASE_INPUT)).rejects.toThrow(
        /RESEND_API_KEY is not configured in staging/,
      );
    });

    it('does NOT log the reset link', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'staging' }));
      await transport.sendResetEmail(BASE_INPUT).catch(() => undefined);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('production environment — no RESEND_API_KEY', () => {
    it('rejects with a configuration error', async () => {
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'production' }));
      await expect(transport.sendResetEmail(BASE_INPUT)).rejects.toThrow(
        /RESEND_API_KEY is not configured in production/,
      );
    });
  });
});

describe('Resend transport (issue #645)', () => {
  it('sends the idempotency key and a body that does not change between retries', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    const transport = buildPasswordResetEmailTransport(
      makeEnv({ ENVIRONMENT: 'production', RESEND_API_KEY: 're_test' }),
    );

    await transport.sendResetEmail(BASE_INPUT);
    await transport.sendResetEmail({ ...BASE_INPUT, expiresAt: new Date('2026-01-01T00:30:00Z') });

    const [first, second] = fetchSpy.mock.calls.map(([, init]) => init);
    expect(new Headers(first?.headers).get('idempotency-key')).toBe(BASE_INPUT.idempotencyKey);
    expect(second?.body).toBe(first?.body);
    fetchSpy.mockRestore();
  });
});

describe('resolveResetTokenDeriver (issue #645)', () => {
  it('derives a stable token when PASSWORD_RESET_TOKEN_KEY is set', async () => {
    const derive = resolveResetTokenDeriver(
      makeEnv({ ENVIRONMENT: 'production', PASSWORD_RESET_TOKEN_KEY: 'k'.repeat(32) }),
    );
    expect(derive).toBeDefined();
    if (derive === undefined) return;
    const request = { requestId: 'r-1', userId: 'u-1' };
    const token = await derive(request);
    expect(token).toMatch(/^[\w-]{43}$/u);
    expect(await derive(request)).toBe(token);
  });

  it('is absent in dev without a key', () => {
    expect(resolveResetTokenDeriver(makeEnv({ ENVIRONMENT: 'dev' }))).toBeUndefined();
  });

  it.each(['staging', 'production'] as const)('throws in %s without a key', (environment) => {
    expect(() => resolveResetTokenDeriver(makeEnv({ ENVIRONMENT: environment }))).toThrow(
      /PASSWORD_RESET_TOKEN_KEY is not configured/u,
    );
  });
});

describe('resolveResetLinkBaseUrl (issue #645)', () => {
  it('uses WEB_APP_URL when it is set', () => {
    const env = makeEnv({ ENVIRONMENT: 'production', WEB_APP_URL: 'https://app.athlya.app' });
    expect(resolveResetLinkBaseUrl(env)).toBe('https://app.athlya.app');
  });

  it('falls back to a placeholder host in dev only', () => {
    expect(resolveResetLinkBaseUrl(makeEnv({ ENVIRONMENT: 'dev' }))).toBe(
      'https://app.athlya.test',
    );
  });

  it.each(['staging', 'production'] as const)(
    'throws in %s rather than emailing a placeholder link',
    (environment) => {
      expect(() => resolveResetLinkBaseUrl(makeEnv({ ENVIRONMENT: environment }))).toThrow(
        /WEB_APP_URL is not configured/u,
      );
    },
  );
});
