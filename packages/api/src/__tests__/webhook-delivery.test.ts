/**
 * Cron webhook delivery (issue #760): the signature a receiver checks,
 * the request sent, and the outcome recorded for each attempt.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  WEBHOOK_BATCH_LIMIT,
  runWebhookDeliveries,
  webhookSignature,
} from '../maintenance/webhook-delivery.js';

const SECRET = `whsec_${'k'.repeat(43)}`;

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    id: '0f000000-0000-4000-8000-000000000001',
    url: 'https://hooks.rive-gauche.fr/athlya',
    secret: SECRET,
    event_id: 'evt-1',
    event_type: 'reservation.created',
    payload: { reservationId: 'r1', classId: 'c1', userId: 'u1' },
    occurred_at: new Date('2026-10-21T08:00:00.000Z'),
    attempts: 1,
    ...overrides,
  };
}

function executor(rows: unknown[], recorded: string | null = 'delivered') {
  const selectRows = vi.fn(
    (query: string, _params: readonly unknown[]) =>
      Promise.resolve(
        query.includes('webhook_claim_deliveries') ? rows : [{ status: recorded }],
      ) as Promise<never[]>,
  );
  return { selectRows };
}

describe('webhookSignature', () => {
  it('is t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<body>">', async () => {
    const body = '{"id":"evt-1"}';
    const expected = createHmac('sha256', SECRET).update(`1761033600.${body}`).digest('hex');
    expect(await webhookSignature(SECRET, 1761033600, body)).toBe(`t=1761033600,v1=${expected}`);
  });
});

describe('runWebhookDeliveries', () => {
  it('posts each claimed delivery signed, and records a 2xx as delivered', async () => {
    const sql = executor([claimed()]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await runWebhookDeliveries({ executeSql: sql, fetch, now: () => 1761033600 });

    expect(result).toEqual({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(sql.selectRows).toHaveBeenCalledWith(
      expect.stringContaining('webhook_claim_deliveries'),
      [WEBHOOK_BATCH_LIMIT],
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.rive-gauche.fr/athlya');
    expect(init?.redirect).toBe('manual');
    const headers = init?.headers as Record<string, string>;
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      id: 'evt-1',
      type: 'reservation.created',
      occurredAt: '2026-10-21T08:00:00.000Z',
      data: { reservationId: 'r1', classId: 'c1', userId: 'u1' },
    });
    expect(headers['athlya-event']).toBe('reservation.created');
    expect(headers['athlya-delivery']).toBe('0f000000-0000-4000-8000-000000000001');
    expect(headers['athlya-signature']).toBe(await webhookSignature(SECRET, 1761033600, body));
    expect(sql.selectRows).toHaveBeenLastCalledWith(
      expect.stringContaining('webhook_record_attempt'),
      ['0f000000-0000-4000-8000-000000000001', 204, null],
    );
  });

  it('records the status of a refusal and a network failure without a status', async () => {
    const sql = executor(
      [claimed(), claimed({ id: '0f000000-0000-4000-8000-000000000002' })],
      'pending',
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await runWebhookDeliveries({ executeSql: sql, fetch });

    expect(result).toEqual({ attempted: 2, delivered: 0, retrying: 2, failed: 0 });
    const recorded = sql.selectRows.mock.calls
      .filter(([q]) => q.includes('webhook_record_attempt'))
      .map(([, params]) => params);
    expect(recorded).toContainEqual(['0f000000-0000-4000-8000-000000000001', 500, 'http_500']);
    expect(recorded).toContainEqual([
      '0f000000-0000-4000-8000-000000000002',
      null,
      'network_error',
    ]);
  });

  it('never posts to a URL that is no longer a public https URL', async () => {
    const sql = executor([claimed({ url: 'https://10.0.0.1/hook' })], 'pending');
    const fetch = vi.fn<typeof globalThis.fetch>();

    await runWebhookDeliveries({ executeSql: sql, fetch });

    expect(fetch).not.toHaveBeenCalled();
    expect(sql.selectRows).toHaveBeenLastCalledWith(expect.any(String), [
      '0f000000-0000-4000-8000-000000000001',
      null,
      'url_refused',
    ]);
  });

  it('does nothing when no delivery is due', async () => {
    const sql = executor([]);
    const fetch = vi.fn<typeof globalThis.fetch>();

    expect(await runWebhookDeliveries({ executeSql: sql, fetch })).toEqual({
      attempted: 0,
      delivered: 0,
      retrying: 0,
      failed: 0,
    });
    expect(sql.selectRows).toHaveBeenCalledTimes(1);
  });
});
