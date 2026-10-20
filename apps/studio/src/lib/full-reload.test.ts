/**
 * The check-in kiosk runs in its own document so it gets its own
 * `camera=(self)` permissions policy: any navigation that enters or leaves
 * it loads a new document, every other one stays a client transition.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigateTo, needsFullReload, ownDocumentRoute } from './full-reload';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ownDocumentRoute', () => {
  it('finds the kiosk for its path, sub-paths and query only', () => {
    expect(ownDocumentRoute('/dashboard/checkin')).toBe('/dashboard/checkin');
    expect(ownDocumentRoute('/dashboard/checkin/')).toBe('/dashboard/checkin');
    expect(ownDocumentRoute('/dashboard/checkin?kiosk=1')).toBe('/dashboard/checkin');
    expect(ownDocumentRoute('/dashboard/checkins')).toBeNull();
    expect(ownDocumentRoute('/dashboard/members?q=checkin')).toBeNull();
  });
});

describe('needsFullReload', () => {
  it('reloads when entering the kiosk from another page', () => {
    expect(needsFullReload('/dashboard/checkin', '/dashboard')).toBe(true);
  });

  it('reloads when leaving the kiosk for another page', () => {
    expect(needsFullReload('/dashboard', '/dashboard/checkin')).toBe(true);
    expect(needsFullReload('/login', '/dashboard/checkin')).toBe(true);
    expect(needsFullReload('/dashboard/classes?new=1', '/dashboard/checkin')).toBe(true);
  });

  it('keeps client transitions inside or outside the kiosk', () => {
    expect(needsFullReload('/dashboard/members', '/dashboard')).toBe(false);
    expect(needsFullReload('/dashboard/checkin?kiosk=1', '/dashboard/checkin')).toBe(false);
  });
});

describe('navigateTo', () => {
  function stubLocation(): ReturnType<typeof vi.fn> {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
  }

  it('loads the kiosk as a new document instead of pushing a client route', () => {
    const assign = stubLocation();
    const push = vi.fn();
    navigateTo('/dashboard/checkin', push, '/dashboard');
    expect(assign).toHaveBeenCalledWith('/dashboard/checkin');
    expect(push).not.toHaveBeenCalled();
  });

  it('leaves the kiosk with a new document too', () => {
    const assign = stubLocation();
    const push = vi.fn();
    navigateTo('/dashboard/members', push, '/dashboard/checkin');
    expect(assign).toHaveBeenCalledWith('/dashboard/members');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a client transition between two ordinary pages', () => {
    const assign = stubLocation();
    const push = vi.fn();
    navigateTo('/dashboard/members', push, '/dashboard');
    expect(push).toHaveBeenCalledWith('/dashboard/members');
    expect(assign).not.toHaveBeenCalled();
  });
});
