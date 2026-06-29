import { describe, it, expect, vi } from 'vitest';

import { buildPasswordResetEmailTransport } from '../../adapters/auth-deps.js';

import type { AthlyaBindings } from '../../types.js';

const BASE_INPUT = {
  to: 'member@example.com',
  link: 'https://athlya.app/reset-password/tok',
  expiresAt: new Date('2026-01-01T00:00:00Z'),
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

    it('logs the reset link to console (not an error)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const transport = buildPasswordResetEmailTransport(makeEnv({ ENVIRONMENT: 'dev' }));
      await transport.sendResetEmail(BASE_INPUT);
      expect(warnSpy).toHaveBeenCalledOnce();
      const [, meta] = warnSpy.mock.calls[0] as [unknown, { link: string }];
      expect(meta.link).toBe(BASE_INPUT.link);
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
