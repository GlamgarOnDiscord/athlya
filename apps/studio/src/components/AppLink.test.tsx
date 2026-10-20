/**
 * `AppLink` hands the kiosk a plain anchor (full document load) and every
 * other route to `next/link`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLink } from './AppLink';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-client-link="true">
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('<AppLink />', () => {
  it('renders the kiosk as a plain anchor', () => {
    render(<AppLink href="/dashboard/checkin">Kiosk</AppLink>);
    const link = screen.getByRole('link', { name: 'Kiosk' });
    expect(link.getAttribute('href')).toBe('/dashboard/checkin');
    expect(link.dataset['clientLink']).toBeUndefined();
  });

  it('keeps next/link for any other route', () => {
    render(<AppLink href="/dashboard/members">Members</AppLink>);
    expect(screen.getByRole('link', { name: 'Members' }).dataset['clientLink']).toBe('true');
  });
});
