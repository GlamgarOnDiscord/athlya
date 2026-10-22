/**
 * The studio sign-in lets administrators and coaches in and refuses a
 * member with a clear message, closing the session the sign-in opened.
 * Opened from a team invitation, it accepts it and takes the new role from
 * the refreshed session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import { LoginForm } from './LoginForm';

const t = createTranslator('en');
const push = vi.fn();
const login = vi.fn();
const logout = vi.fn();
const refreshSession = vi.fn();
const post = vi.fn();
const INVITE = 'a'.repeat(43);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ login, logout, refreshSession }),
}));

vi.mock('../../lib/api/buildClient', () => ({
  useApiClient: () => ({ post }),
}));

function session(role: 'admin' | 'coach' | 'member') {
  return {
    accessToken: 'jwt',
    accessTokenExpiresIn: 900,
    user: { id: 'u1', email: 'a@example.com', displayName: 'Ines Garnier', studioId: 's1', role },
  };
}

function signIn(): void {
  render(
    <LocaleProvider locale="en">
      <LoginForm nonce="" />
    </LocaleProvider>,
  );
  fireEvent.change(screen.getByLabelText(t('auth.login.email')), {
    target: { value: 'a@example.com' },
  });
  fireEvent.change(screen.getByLabelText(t('auth.login.password')), {
    target: { value: 'correct horse battery' },
  });
  fireEvent.click(screen.getByRole('button', { name: t('auth.login.submit') }));
}

beforeEach(() => {
  push.mockReset();
  login.mockReset();
  logout.mockReset();
  logout.mockResolvedValue(undefined);
  refreshSession.mockReset();
  post.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('<LoginForm /> role gate', () => {
  it.each(['admin', 'coach'] as const)('sends an %s to the dashboard', async (role) => {
    login.mockResolvedValue(session(role));
    signIn();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a member with a clear message and closes the session', async () => {
    login.mockResolvedValue(session('member'));
    signIn();
    expect((await screen.findByRole('alert')).textContent).toBe(t('studio.login.staffRequired'));
    expect(logout).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it('still refuses a member when the sign-out request fails', async () => {
    login.mockResolvedValue(session('member'));
    logout.mockRejectedValue(new Error('offline'));
    signIn();
    expect((await screen.findByRole('alert')).textContent).toBe(t('studio.login.staffRequired'));
    expect(push).not.toHaveBeenCalled();
  });
});

describe('<LoginForm /> team invitation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/login#invite=${INVITE}`);
    login.mockResolvedValue(session('member'));
    post.mockResolvedValue({ role: 'coach' });
  });

  it('opens the dashboard with the role of the refreshed session', async () => {
    refreshSession.mockResolvedValue({ ...session('coach').user });
    signIn();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(post).toHaveBeenCalledWith('/v1/studios/me/team/invitations/accept', {
      token: INVITE,
    });
    expect(logout).not.toHaveBeenCalled();
  });

  it('reports a network error, not a member account, when the refresh fails', async () => {
    refreshSession.mockResolvedValue(null);
    signIn();
    expect((await screen.findByRole('alert')).textContent).toBe(t('auth.errors.networkError'));
    expect(post).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});
