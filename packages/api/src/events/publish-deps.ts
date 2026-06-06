/**
 * Shared {@link PublishDeps} factory for domain adapters — routes each
 * event to the lane-specific queue binding (issue #125).
 */

import { resolveEventQueueProducer, type EventQueueBindings } from './route-queue.js';

import type { PublishDeps, Queue } from './publish.js';
import type { AthlyaBindings } from '../types.js';

/** Build publish deps that route by `event.type`. */
export function buildRoutedPublishDeps(env: AthlyaBindings): PublishDeps {
  const queues = env as unknown as EventQueueBindings;
  return {
    resolveQueue: (eventType: string) =>
      resolveEventQueueProducer(queues, eventType) as unknown as Queue,
  };
}
