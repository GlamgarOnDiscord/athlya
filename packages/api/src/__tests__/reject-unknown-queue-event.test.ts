import { describe, expect, it, vi } from 'vitest';

import { rejectUnknownQueueEvent } from '../events/reject-unknown-queue-event.js';

describe('rejectUnknownQueueEvent', () => {
  it('logs, sends payload to DLQ, and acks the primary message', async () => {
    const msg = {
      id: 'msg-1',
      body: { type: 'unknown.type', id: 'evt-1' },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const dlqSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await rejectUnknownQueueEvent(
      msg,
      { queue: 'athlya-events', messageId: 'msg-1', eventType: 'unknown.type', eventId: 'evt-1' },
      { EVENTS_DLQ: { send: dlqSend } },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      'queue.unknown_event_type',
      expect.objectContaining({
        code: 'unknown_event_type',
        metric: 'queue_unknown_event_total',
        eventType: 'unknown.type',
      }),
    );
    expect(dlqSend).toHaveBeenCalledWith(msg.body);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('retries when DLQ send fails', async () => {
    const msg = {
      id: 'msg-2',
      body: { type: 'bad.type' },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await rejectUnknownQueueEvent(
      msg,
      { queue: 'athlya-events-rgpd', messageId: 'msg-2', eventType: 'bad.type' },
      { EVENTS_DLQ: { send: vi.fn().mockRejectedValue(new Error('network')) } },
    );

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
