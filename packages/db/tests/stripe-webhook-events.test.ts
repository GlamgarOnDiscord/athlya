import { describe, expect, it } from 'vitest';

import { claimStripeWebhookEvent } from '../src/stripe-webhook-events.js';

import { makeFakeTx } from './_sql-capture.js';

describe('claimStripeWebhookEvent', () => {
  it('inserts a new event_id and returns true', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    enqueueResult([{ event_id: 'evt_123' }]);

    const claimed = await claimStripeWebhookEvent(tx, 'evt_123', 'checkout.session.completed');

    expect(claimed).toBe(true);
  });

  it('returns false on duplicate (ON CONFLICT DO NOTHING)', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    enqueueResult([]);

    const claimed = await claimStripeWebhookEvent(tx, 'evt_123', 'checkout.session.completed');

    expect(claimed).toBe(false);
  });
});
