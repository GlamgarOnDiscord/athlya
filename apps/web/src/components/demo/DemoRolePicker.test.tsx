/**
 * The member demo picker offers the member profile of the demo, Léa
 * Fontaine, the same person as the member test account of the studio.
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
  it('signs Léa Fontaine in as a member with the demo password', async () => {
    login.mockResolvedValue(undefined);
    render(
      <LocaleProvider locale="en">
        <DemoRolePicker />
      </LocaleProvider>,
    );
    const button = screen.getByRole('button', {
      name: t('demo.picker.signInAs', { name: 'Léa Fontaine', role: t('demo.picker.member') }),
    });
    fireEvent.click(button);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith({ email: 'lea.fontaine@example.com', password: 'demo' });
  });
});
