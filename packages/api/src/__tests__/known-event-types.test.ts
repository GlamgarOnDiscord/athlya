import { describe, expect, it, vi } from 'vitest';

import { ALL_KNOWN_EVENT_TYPES, isKnownEventType } from '../events/known-event-types.js';

describe('known-event-types', () => {
  it('includes notification and RGPD routed types', () => {
    expect(ALL_KNOWN_EVENT_TYPES).toContain('reservation.created');
    expect(ALL_KNOWN_EVENT_TYPES).toContain('auth.user.deleted');
    expect(ALL_KNOWN_EVENT_TYPES).toContain('members.export.requested');
  });

  it('rejects unknown dotted types', () => {
    expect(isKnownEventType('auth.user.registered')).toBe(false);
    expect(isKnownEventType('totally.new.event')).toBe(false);
  });
});
