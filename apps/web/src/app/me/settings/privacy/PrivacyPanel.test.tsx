import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { LocaleProvider } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';

import { PrivacyPanel } from './PrivacyPanel';

import type { ApiClient } from '../../../../lib/api/client';

const t = createTranslator('fr');

const ME = {
  email: 'alice@athlya.app',
  displayName: 'Alice',
  avatarUrl: null,
  consents: {
    marketing: true,
    analytics: false,
    thirdParty: false,
    version: '2026-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

afterEach(() => {
  cleanup();
});

function renderPanel(get: ApiClient['get']): void {
  const client: ApiClient = {
    get,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    postStream: vi.fn(),
  };
  render(
    <LocaleProvider locale="fr">
      <PrivacyPanel client={client} />
    </LocaleProvider>,
  );
}

describe('<PrivacyPanel />', () => {
  it('shows the consents from /v1/members/me, the export and the deletion', async () => {
    const get = vi.fn().mockResolvedValue(ME);
    renderPanel(get);

    const marketing = await screen.findByRole('checkbox', { name: t('consents.marketing') });
    expect(marketing.getAttribute('aria-checked')).toBe('true');
    expect(get).toHaveBeenCalledWith('/v1/members/me');
    expect(screen.getByRole('heading', { name: t('rgpd.export.title') })).toBeDefined();
    expect(screen.getByRole('button', { name: t('rgpd.export.request') })).toBeDefined();
    expect(screen.getByRole('button', { name: t('rgpd.delete.confirm') })).toBeDefined();
  });

  it('keeps export and deletion reachable when the profile fails to load', async () => {
    renderPanel(vi.fn().mockRejectedValue(new Error('offline')));

    expect((await screen.findByRole('alert')).textContent).toContain(t('errors.generic'));
    expect(screen.getByRole('button', { name: t('rgpd.export.request') })).toBeDefined();
    expect(screen.getByRole('button', { name: t('rgpd.delete.confirm') })).toBeDefined();
  });
});
