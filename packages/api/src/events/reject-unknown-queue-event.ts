/**
 * Reject queue messages whose `event.type` is not handled by any
 * consumer lane — log metric, redirect to DLQ, ack primary message.
 */

export interface UnknownQueueEventContext {
  readonly queue: string;
  readonly messageId: string;
  readonly eventType: string;
  readonly eventId?: string | undefined;
}

export interface UnknownQueueEventBindings {
  readonly EVENTS_DLQ: { send(message: unknown): Promise<unknown> };
}

export interface QueueMessageLike {
  readonly body: unknown;
  readonly id: string;
  ack(): void;
  retry(): void;
}

/**
 * Emit `queue_unknown_event_total` (via structured log) and quarantine
 * the payload on `athlya-events-dlq` instead of acking silently.
 */
export async function rejectUnknownQueueEvent(
  msg: QueueMessageLike,
  ctx: UnknownQueueEventContext,
  env: UnknownQueueEventBindings,
): Promise<void> {
  console.error('queue.unknown_event_type', {
    code: 'unknown_event_type',
    metric: 'queue_unknown_event_total',
    queue: ctx.queue,
    messageId: ctx.messageId,
    eventType: ctx.eventType,
    eventId: ctx.eventId ?? null,
  });

  try {
    await env.EVENTS_DLQ.send(msg.body);
    msg.ack();
  } catch (err) {
    console.error('[queue] unknown event DLQ redirect failed, retrying', {
      queue: ctx.queue,
      messageId: ctx.messageId,
      eventType: ctx.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    msg.retry();
  }
}
