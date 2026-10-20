/**
 * The check-in kiosk is entered with a full document load so it gets its
 * own `camera=(self)` permissions policy; every other route keeps client
 * transitions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigateTo, needsFullReload } from './full-reload';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('needsFullReload', () => {
  it('matches the kiosk, its sub-paths and its query, nothing else', () => {
    expect(needsFullReload('/dashboard/checkin')).toBe(true);
    expect(needsFullReload('/dashboard/checkin/')).toBe(true);
    expect(needsFullReload('/dashboard/checkin?kiosk=1')).toBe(true);
    expect(needsFullReload('/dashboard/checkins')).toBe(false);
    expect(needsFullReload('/dashboard')).toBe(false);
    expect(needsFullReload('/dashboard/members?q=checkin')).toBe(false);
  });
});

describe('navigateTo', () => {
  it('loads the kiosk as a new document instead of pushing a client route', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const push = vi.fn();
    navigateTo('/dashboard/checkin', push);
    expect(assign).toHaveBeenCalledWith('/dashboard/checkin');
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a client transition for any other route', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const push = vi.fn();
    navigateTo('/dashboard/members', push);
    expect(push).toHaveBeenCalledWith('/dashboard/members');
    expect(assign).not.toHaveBeenCalled();
  });
});
