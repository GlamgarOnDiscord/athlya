import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';

import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';

import type { ApiClient } from '../../../../lib/api/client';

const t = createTranslator('fr');

const PREFS = {
  reservationCreated: { email: true, push: true },
  reservationReminder: { push: true },
  reservationCancelled: { email: true, push: false },
  reservationPromoted: { email: true, push: true },
};

afterEach(() => {
  cleanup();
});

function renderPanel(client: Partial<ApiClient>): void {
  render(
    <LocaleProvider locale="fr">
      <NotificationPreferencesPanel
        client={
          {
            get: vi.fn(),
            post: vi.fn(),
            patch: vi.fn(),
            put: vi.fn(),
            del: vi.fn(),
            postStream: vi.fn(),
            ...client,
          } as ApiClient
        }
      />
    </LocaleProvider>,
  );
}

describe('<NotificationPreferencesPanel />', () => {
  it('shows one toggle per channel and locks the mandatory messages', async () => {
    renderPanel({ get: vi.fn().mockResolvedValue({ preferences: PREFS }) });

    await screen.findAllByText(t('web.settings.notifications.events.reservationCreated'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(7);
    expect(screen.getAllByText(t('web.settings.notifications.alwaysSent'))).toHaveLength(2);
    expect(screen.getByText(t('web.settings.notifications.events.passwordReset'))).toBeDefined();
    // Order: created (email, push), reminder (push), cancelled (email, push), promoted.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true',
      'true',
      'false',
      'true',
      'true',
    ]);
  });

  it('saves the whole set after a change', async () => {
    const put = vi.fn().mockResolvedValue({
      preferences: { ...PREFS, reservationCreated: { email: false, push: true } },
    });
    renderPanel({ get: vi.fn().mockResolvedValue({ preferences: PREFS }), put });

    await screen.findAllByText(t('web.settings.notifications.events.reservationCreated'));
    const save = screen.getByRole('button', { name: t('web.settings.notifications.save') });
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(save);

    await waitFor(() => {
      expect(put).toHaveBeenCalledOnce();
    });
    const [path, body] = put.mock.calls[0] as [string, string];
    expect(path).toBe('/v1/members/me/notification-preferences');
    expect(JSON.parse(body)).toEqual({
      ...PREFS,
      reservationCreated: { email: false, push: true },
    });
    expect(await screen.findByText(t('web.settings.notifications.saved'))).toBeDefined();
  });

  it('offers a retry when the preferences cannot be loaded', async () => {
    renderPanel({ get: vi.fn().mockRejectedValue(new Error('down')) });
    expect(await screen.findByText(t('web.settings.notifications.loadError'))).toBeDefined();
  });
});
