/**
 * The dashboard gate: admins see every page, coaches only the check-in
 * kiosk (the API opens `POST /v1/checkins` to them too), members none.
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
  it('matches the kiosk and its sub-paths only', () => {
    expect(isCoachRoute('/dashboard/checkin')).toBe(true);
    expect(isCoachRoute('/dashboard/checkin/')).toBe(true);
    expect(isCoachRoute('/dashboard/checkins')).toBe(false);
    expect(isCoachRoute('/dashboard/members')).toBe(false);
    expect(isCoachRoute('/dashboard')).toBe(false);
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

  it('sends a coach from any other dashboard page to the kiosk with a full page load', () => {
    role = 'coach';
    pathname = '/dashboard/members';
    renderGate();
    expect(screen.queryByText('dashboard content')).toBeNull();
    // A client transition would keep the camera=() policy of the page left behind.
    expect(assign).toHaveBeenCalledWith('/dashboard/checkin');
    expect(push).not.toHaveBeenCalled();
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
