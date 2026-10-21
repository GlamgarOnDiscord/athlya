/**
 * The dashboard gate: admins see every page; coaches their home, their
 * schedule, the members directory and the kiosk (the API opens
 * `GET /v1/classes`, `GET /v1/members` and `POST /v1/checkins` to them);
 * members none.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCoachRoute, RequireAdmin } from './RequireAdmin';

const push = vi.fn();
let pathname = '/dashboard';
let role: 'admin' | 'coach' | 'member' = 'admin';

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

describe('isCoachRoute', () => {
  it('matches the coach pages and their sub-paths', () => {
    expect(isCoachRoute('/dashboard')).toBe(true);
    expect(isCoachRoute('/dashboard/planning')).toBe(true);
    expect(isCoachRoute('/dashboard/members')).toBe(true);
    expect(isCoachRoute('/dashboard/checkin')).toBe(true);
    expect(isCoachRoute('/dashboard/checkin/')).toBe(true);
  });

  it('opens a class roster but not a member file', () => {
    expect(isCoachRoute('/dashboard/classes/cccccccc-cccc-4ccc-8ccc-cccccccccc01')).toBe(true);
    expect(isCoachRoute('/dashboard/classes/c1/edit')).toBe(false);
    expect(isCoachRoute('/dashboard/classes/new')).toBe(false);
    expect(isCoachRoute('/dashboard/members/11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('matches the home exactly, so it never opens the admin pages below it', () => {
    for (const admin of [
      '/dashboard/classes',
      '/dashboard/programs',
      '/dashboard/rooms',
      '/dashboard/branding',
      '/dashboard/billing',
      '/dashboard/audit',
      '/dashboard/checkins',
      '/dashboard/planning-admin',
    ]) {
      expect(isCoachRoute(admin)).toBe(false);
    }
  });
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
