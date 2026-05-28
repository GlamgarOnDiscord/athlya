import { EVENT_TYPES } from '@athlya/shared/events';
import { describe, expect, it } from 'vitest';

import {
  isNotificationsConsumerQueue,
  isRgpdConsumerQueue,
  resolveEventQueueLane,
} from '../events/route-queue.js';

describe('resolveEventQueueLane', () => {
  it('routes reservation and billing failure events to notifications', () => {
    expect(resolveEventQueueLane('reservation.created')).toBe('notifications');
    expect(resolveEventQueueLane('reservation.reminder')).toBe('notifications');
    expect(resolveEventQueueLane('billing.subscription.failed')).toBe('notifications');
  });

  it('routes RGPD cascade and export job requests to rgpd', () => {
    expect(resolveEventQueueLane('auth.user.deleted')).toBe('rgpd');
    expect(resolveEventQueueLane('members.export.requested')).toBe('rgpd');
  });

  it('keeps members.export.completed on legacy until a consumer exists', () => {
    expect(resolveEventQueueLane('members.export.completed')).toBe('legacy');
  });

  it('keeps reservation.waitlisted on legacy (not in notifications handler)', () => {
    expect(resolveEventQueueLane('reservation.waitlisted')).toBe('legacy');
  });

  it('keeps unmapped EVENT_TYPES on legacy until migrated', () => {
    const legacy = EVENT_TYPES.filter(
      (type) =>
        !type.startsWith('reservation.') &&
        type !== 'billing.subscription.failed' &&
        type !== 'auth.user.deleted' &&
        !type.startsWith('members.export.'),
    );
    for (const type of legacy) {
      expect(resolveEventQueueLane(type)).toBe('legacy');
    }
  });
});

describe('consumer queue name helpers', () => {
  it('detects lane-specific consumer queues', () => {
    expect(isNotificationsConsumerQueue('athlya-events-notifications')).toBe(true);
    expect(isNotificationsConsumerQueue('athlya-events-notifications-staging')).toBe(true);
    expect(isNotificationsConsumerQueue('athlya-events-notifications-dlq')).toBe(false);
    expect(isRgpdConsumerQueue('athlya-events-rgpd-staging')).toBe(true);
    expect(isRgpdConsumerQueue('athlya-events-rgpd-dlq')).toBe(false);
    expect(isNotificationsConsumerQueue('athlya-events')).toBe(false);
  });
});
