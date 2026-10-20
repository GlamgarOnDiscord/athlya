/**
 * `AppLink` hands a link that enters or leaves the kiosk a plain anchor
 * (full document load) and every other one to `next/link`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLink } from './AppLink';

let pathname = '/dashboard';

vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

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

function isClientLink(name: string): boolean {
  return screen.getByRole('link', { name }).dataset['clientLink'] === 'true';
}

describe('<AppLink />', () => {
  it('renders a link into the kiosk as a plain anchor', () => {
    pathname = '/dashboard';
    render(<AppLink href="/dashboard/checkin">Kiosk</AppLink>);
    expect(screen.getByRole('link', { name: 'Kiosk' }).getAttribute('href')).toBe(
      '/dashboard/checkin',
    );
    expect(isClientLink('Kiosk')).toBe(false);
  });

  it('renders a link out of the kiosk as a plain anchor', () => {
    pathname = '/dashboard/checkin';
    render(<AppLink href="/dashboard">Dashboard</AppLink>);
    expect(isClientLink('Dashboard')).toBe(false);
  });

  it('keeps next/link between two ordinary pages', () => {
    pathname = '/dashboard';
    render(<AppLink href="/dashboard/members">Members</AppLink>);
    expect(isClientLink('Members')).toBe(true);
  });
});
