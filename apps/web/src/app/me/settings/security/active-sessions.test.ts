import { describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../../../lib/i18n/t';

import {
  deviceLabel,
  fetchActiveSessions,
  lastSeenLabel,
  orderSessions,
  revokeActiveSession,
} from './active-sessions';

import type { ActiveSession } from '@athlya/shared/schemas/api';

const t = createTranslator('en');

function session(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    id: 'a'.repeat(32),
    device: { browser: 'chrome', os: 'macos' },
    createdAt: '2026-10-20T08:00:00.000Z',
    lastSeenAt: '2026-10-21T08:00:00.000Z',
    expiresAt: '2026-11-20T08:00:00.000Z',
    current: false,
    ...overrides,
  };
}

describe('active sessions', () => {
  it('reads and revokes through the auth routes', async () => {
    const get = vi.fn().mockResolvedValue({ items: [session({})] });
    const del = vi.fn().mockResolvedValue(undefined);

    expect(await fetchActiveSessions({ get })).toHaveLength(1);
    await revokeActiveSession({ del }, 'b'.repeat(32));

    expect(get).toHaveBeenCalledWith('/v1/auth/sessions');
    expect(del).toHaveBeenCalledWith(`/v1/auth/sessions/${'b'.repeat(32)}`);
  });

  it('names the device, or says it is unknown', () => {
    expect(deviceLabel(session({}), t)).toBe('Chrome on macOS');
    expect(deviceLabel(session({ device: { browser: 'app', os: 'ios' } }), t)).toBe(
      'Athlya app on iOS',
    );
    expect(deviceLabel(session({ device: null }), t)).toBe('Unknown device');
  });

  it('dates the last activity, falling back to the sign-in, then to a plain label', () => {
    expect(lastSeenLabel(session({}), 'en', t)).toMatch(/^Last active October 21/u);
    expect(lastSeenLabel(session({ lastSeenAt: null }), 'en', t)).toMatch(/October 20/u);
    expect(lastSeenLabel(session({ lastSeenAt: null, createdAt: null }), 'en', t)).toBe(
      'Active session',
    );
  });

  it('puts this device first, then the most recently active', () => {
    const old = session({ id: '1'.repeat(32), lastSeenAt: '2026-10-01T00:00:00.000Z' });
    const recent = session({ id: '2'.repeat(32), lastSeenAt: '2026-10-21T00:00:00.000Z' });
    const mine = session({ id: '3'.repeat(32), current: true, lastSeenAt: null, createdAt: null });

    expect(orderSessions([old, recent, mine]).map((s) => s.id[0])).toEqual(['3', '2', '1']);
  });
});
