import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const logoutMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('../../../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ logout: logoutMock }),
}));

import { LocaleProvider } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';

import { SecurityPanel } from './SecurityPanel';

import type { ApiClient } from '../../../../lib/api/client';

const t = createTranslator('fr');

function fakeClient(post: ApiClient['post']): ApiClient {
  return { get: vi.fn(), post, patch: vi.fn(), put: vi.fn(), del: vi.fn(), postStream: vi.fn() };
}

function renderPanel(client: ApiClient): void {
  render(
    <LocaleProvider locale="fr">
      <SecurityPanel client={client} />
    </LocaleProvider>,
  );
}

async function confirmSignOutEverywhere(): Promise<void> {
  fireEvent.click(
    screen.getByRole('button', { name: t('web.settings.security.signOutAll.action') }),
  );
  await act(async () => {
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.settings.security.signOutAll.confirm') }),
    );
  });
}

beforeEach(() => {
  pushMock.mockReset();
  logoutMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('<SecurityPanel />', () => {
  it('links the password change to the reset-by-email flow', () => {
    renderPanel(fakeClient(vi.fn()));
    expect(
      screen.getByRole('link', { name: t('web.settings.security.password.action') }),
    ).toHaveProperty('pathname', '/forgot-password');
  });

  it('announces the sessions list as coming, without a control', () => {
    renderPanel(fakeClient(vi.fn()));
    expect(screen.getByText(t('web.settings.security.sessions.title'))).toBeDefined();
    expect(screen.getAllByText(t('web.settings.comingSoon'))).toHaveLength(1);
  });

  it('signs out of this device and goes to the login page', async () => {
    renderPanel(fakeClient(vi.fn()));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('auth.logout') }));
    });
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  it('still goes to the login page when the local sign-out request fails', async () => {
    logoutMock.mockRejectedValue(new Error('offline'));
    renderPanel(fakeClient(vi.fn()));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('auth.logout') }));
    });
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  it('signs out everywhere after confirmation', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    renderPanel(fakeClient(post));
    await confirmSignOutEverywhere();
    expect(post).toHaveBeenCalledWith('/v1/auth/logout-all', {});
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  it('reports a failure and keeps the session', async () => {
    const post = vi.fn().mockRejectedValue(new Error('offline'));
    renderPanel(fakeClient(post));
    await confirmSignOutEverywhere();
    expect((await screen.findByRole('alert')).textContent).toBe(t('errors.generic'));
    expect(logoutMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
