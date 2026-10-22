/**
 * The dashboard gate: admins see every page; managers all but billing and
 * branding; the front desk and coaches their home, the schedule, the
 * members directory and the kiosk; members none. The page table itself is
 * covered by `lib/auth/console-routes.test.ts`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequireAdmin } from './RequireAdmin';

import type { Role } from '@athlya/shared/roles';

const push = vi.fn();
let pathname = '/dashboard';
let role: Role = 'admin';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

vi.mock('../lib/auth/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isAdmin: role === 'admin',
    user: { id: 'u1', role, studioId: 's1' },
    bootResolved: true,
  }),
}));

function renderGate(): void {
  render(
    <RequireAdmin>
      <p>dashboard content</p>
    </RequireAdmin>,
  );
}

const assign = vi.fn();

beforeEach(() => {
  push.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<RequireAdmin />', () => {
  it('shows every dashboard page to an admin', () => {
    role = 'admin';
    pathname = '/dashboard/members';
    renderGate();
    expect(screen.getByText('dashboard content')).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });

  it('lets a coach open the check-in kiosk', () => {
    role = 'coach';
    pathname = '/dashboard/checkin';
    renderGate();
    expect(screen.getByText('dashboard content')).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['/dashboard', '/dashboard/planning', '/dashboard/members'])(
    'lets a coach open %s',
    (path) => {
      role = 'coach';
      pathname = path;
      renderGate();
      expect(screen.getByText('dashboard content')).toBeDefined();
      expect(push).not.toHaveBeenCalled();
    },
  );

  it.each(['/dashboard/classes', '/dashboard/billing', '/dashboard/audit'])(
    'sends a coach from the admin page %s to their home',
    (path) => {
      role = 'coach';
      pathname = path;
      renderGate();
      expect(screen.queryByText('dashboard content')).toBeNull();
      expect(push).toHaveBeenCalledWith('/dashboard');
    },
  );

  it.each<[Role, string]>([
    ['manager', '/dashboard/billing'],
    ['manager', '/dashboard/branding'],
    ['accueil', '/dashboard/classes'],
    ['accueil', '/dashboard/team'],
  ])('sends a %s from %s to the console home', (who, path) => {
    role = who;
    pathname = path;
    renderGate();
    expect(screen.queryByText('dashboard content')).toBeNull();
    expect(push).toHaveBeenCalledWith('/dashboard');
  });

  it.each<[Role, string]>([
    ['manager', '/dashboard/team'],
    ['accueil', '/dashboard/members/11111111-1111-4111-8111-111111111111'],
  ])('lets a %s open %s', (who, path) => {
    role = who;
    pathname = path;
    renderGate();
    expect(screen.getByText('dashboard content')).toBeDefined();
  });

  it('keeps a member out of the kiosk, leaving it with a full page load', () => {
    role = 'member';
    pathname = '/dashboard/checkin';
    renderGate();
    expect(screen.queryByText('dashboard content')).toBeNull();
    expect(assign).toHaveBeenCalledWith('/forbidden');
    expect(push).not.toHaveBeenCalled();
  });

  it('sends a member from an ordinary page to /forbidden with a client transition', () => {
    role = 'member';
    pathname = '/dashboard/members';
    renderGate();
    expect(push).toHaveBeenCalledWith('/forbidden');
    expect(assign).not.toHaveBeenCalled();
  });
});
