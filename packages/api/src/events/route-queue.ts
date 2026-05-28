/**
 * Event-bus queue routing — maps `event.type` to a dedicated lane so
 * slow RGPD handlers (export ZIP) cannot block notification delivery.
 *
 * ADR: `docs/runbooks/event-bus.md` §6 (issue #125).
 */

import { HANDLED_EVENT_TYPES } from '@athlya/notifications';

/** Named queue lanes provisioned in `wrangler.toml`. */
export type EventQueueLane = 'notifications' | 'rgpd' | 'legacy';

/** Minimal producer surface shared by publish, drain and DLQ replay. */
export interface EventQueueProducer {
  send(message: unknown): Promise<unknown>;
}

/** Bindings required to route publishes and outbox drain. */
export interface EventQueueBindings {
  readonly EVENTS_QUEUE: EventQueueProducer;
  readonly EVENTS_NOTIFICATIONS_QUEUE: EventQueueProducer;
  readonly EVENTS_RGPD_QUEUE: EventQueueProducer;
}

const NOTIFICATION_ROUTED_TYPES = new Set<string>(HANDLED_EVENT_TYPES);

/**
 * Resolve the queue lane for a dotted event type. Unknown types stay on
 * the legacy `athlya-events` topic until operators migrate them.
 */
export function resolveEventQueueLane(eventType: string): EventQueueLane {
  if (NOTIFICATION_ROUTED_TYPES.has(eventType)) {
    return 'notifications';
  }
  if (eventType === 'auth.user.deleted' || eventType === 'members.export.requested') {
    return 'rgpd';
  }
  return 'legacy';
}

/** Pick the Cloudflare Queues producer for `eventType`. */
export function resolveEventQueueProducer(
  env: EventQueueBindings,
  eventType: string,
): EventQueueProducer {
  switch (resolveEventQueueLane(eventType)) {
    case 'notifications':
      return env.EVENTS_NOTIFICATIONS_QUEUE;
    case 'rgpd':
      return env.EVENTS_RGPD_QUEUE;
    default:
      return env.EVENTS_QUEUE;
  }
}

/** True when the consumer queue name is the notifications lane (not its DLQ). */
export function isNotificationsConsumerQueue(queueName: string): boolean {
  return queueName.includes('events-notifications') && !queueName.endsWith('-dlq');
}

/** True when the consumer queue name is the RGPD lane (not its DLQ). */
export function isRgpdConsumerQueue(queueName: string): boolean {
  return queueName.includes('events-rgpd') && !queueName.endsWith('-dlq');
}
