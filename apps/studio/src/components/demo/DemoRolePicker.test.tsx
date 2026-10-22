/**
 * The studio demo picker offers one profile per staff role and signs in
 * with the profile's demo email. The member profile lives in the member
 * app, since a member cannot use the console.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import { DemoRolePicker } from './DemoRolePicker';

const t = createTranslator('en');
const push = vi.fn();
const login = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ login }),
}));

function renderPicker(): void {
  render(
    <LocaleProvider locale="en">
      <DemoRolePicker />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '1');
  push.mockReset();
  login.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('DemoRolePicker', () => {
  it('renders the four studio profiles, one per staff role', () => {
    renderPicker();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      t('demo.picker.signInAs', { name: 'Camille Durand', role: t('demo.picker.admin') }),
      t('demo.picker.signInAs', {
        name: 'Hugo Lefebvre',
        role: t('studio.members.role.manager'),
      }),
      t('demo.picker.signInAs', {
        name: 'Sarah Benali',
        role: t('studio.members.role.accueil'),
      }),
      t('demo.picker.signInAs', { name: 'Inès Garnier', role: t('demo.picker.coach') }),
    ]);
    expect(screen.queryByText(/Léa Fontaine/u)).toBeNull();
  });

  it.each([
    ['Hugo Lefebvre', 'hugo.lefebvre@example.com'],
    ['Sarah Benali', 'sarah.benali@example.com'],
  ])('signs %s in with the demo password, then opens the console', async (name, email) => {
    login.mockResolvedValue(undefined);
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'u') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(login).toHaveBeenCalledWith({ email, password: 'demo' });
  });

  it('renders nothing outside a demo build', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
    renderPicker();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
