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

const SESSIONS = [
  {
    id: 'a'.repeat(32),
    device: { browser: 'chrome', os: 'macos' },
    createdAt: '2026-10-20T08:00:00.000Z',
    lastSeenAt: '2026-10-21T08:00:00.000Z',
    expiresAt: '2026-11-20T08:00:00.000Z',
    current: true,
  },
  {
    id: 'b'.repeat(32),
    device: { browser: 'safari', os: 'ios' },
    createdAt: '2026-10-01T08:00:00.000Z',
    lastSeenAt: '2026-10-19T08:00:00.000Z',
    expiresAt: '2026-11-01T08:00:00.000Z',
    current: false,
  },
];

function fakeClient(
  post: ApiClient['post'],
  del: ApiClient['del'] = vi.fn().mockResolvedValue(undefined),
): ApiClient {
  return {
    get: vi.fn().mockResolvedValue({ items: SESSIONS }),
    post,
    patch: vi.fn(),
    put: vi.fn(),
    del,
    postStream: vi.fn(),
  };
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

  it('lists the active sessions, this device marked and the others revocable', async () => {
    renderPanel(fakeClient(vi.fn()));
    expect(await screen.findByText('Chrome sur macOS')).toBeDefined();
    expect(screen.getByText('Safari sur iOS')).toBeDefined();
    expect(screen.getByText(t('web.settings.security.sessions.current'))).toBeDefined();
    expect(
      screen.getAllByRole('button', { name: t('web.settings.security.sessions.revoke') }),
    ).toHaveLength(1);
    expect(screen.queryByText(t('web.settings.comingSoon'))).toBeNull();
  });

  it('revokes another session after a confirmation', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    renderPanel(fakeClient(vi.fn(), del));
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.settings.security.sessions.revoke') }),
    );
    await act(async () => {
      fireEvent.click(
        await screen.findByRole('button', {
          name: t('web.settings.security.sessions.revokeConfirm'),
        }),
      );
    });
    expect(del).toHaveBeenCalledWith(`/v1/auth/sessions/${'b'.repeat(32)}`);
    expect(await screen.findByText(t('web.settings.security.sessions.revoked'))).toBeDefined();
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
