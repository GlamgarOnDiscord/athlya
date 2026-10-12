import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  applyStripeEvent,
  buildBillingDeps,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  listStudioInvoices,
} from '../../adapters/billing-deps.js';

import type { AthlyaBindings } from '../../types.js';
import type { AthlyaDbAny } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/** Issue #122 — billing adapters over the 0036 functions. */

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const dialect = new PgDialect();

function fakeDb(respond: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query);
      calls.push({ sql, params });
      return Promise.resolve({ rows: respond(sql, params) });
    },
  };
  return { db: db as unknown as AthlyaDbAny, calls };
}

const invoiceRow = (n: number) => ({
  id: `0193f000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  stripe_invoice_id: `in_${String(n)}`,
  number: `A-${String(n)}`,
  status: 'paid',
  amount_due: 4900,
  currency: 'eur',
  hosted_invoice_url: 'https://invoice.stripe.com/i/x',
  created_at: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
});

describe('invoice cursor', () => {
  it('round-trips and rejects garbage', () => {
    const cursor = encodeInvoiceCursor('2026-10-12T00:00:00.000Z', invoiceRow(1).id);
    expect(decodeInvoiceCursor(cursor)).toEqual({
      createdAt: '2026-10-12T00:00:00.000Z',
      id: invoiceRow(1).id,
    });
    expect(decodeInvoiceCursor('!!!')).toBeNull();
    expect(decodeInvoiceCursor(btoa('nope|x'))).toBeNull();
  });
});

describe('listStudioInvoices', () => {
  it('maps rows to the API projection and emits a next cursor on overflow', async () => {
    const { db, calls } = fakeDb(() => [invoiceRow(3), invoiceRow(2), invoiceRow(1)]);
    const page = await listStudioInvoices(db, STUDIO, { limit: 2 });

    expect(page.items).toEqual([
      {
        id: 'in_3',
        number: 'A-3',
        status: 'paid',
        amountDue: 4900,
        currency: 'eur',
        createdAt: '2026-10-13T00:00:00.000Z',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/x',
      },
      expect.objectContaining({ id: 'in_2' }),
    ]);
    expect(decodeInvoiceCursor(page.nextCursor!)).toEqual({
      createdAt: '2026-10-12T00:00:00.000Z',
      id: invoiceRow(2).id,
    });
    expect(calls[0]?.sql).toContain('billing_list_invoices(');
    expect(calls[0]?.params).toEqual([STUDIO, null, null, 3]);
  });

  it('passes the decoded cursor and returns no cursor on the last page', async () => {
    const { db, calls } = fakeDb(() => [invoiceRow(1)]);
    const cursor = encodeInvoiceCursor('2026-10-12T00:00:00.000Z', invoiceRow(2).id);
    const page = await listStudioInvoices(db, STUDIO, { cursor, limit: 20 });
    expect(page.nextCursor).toBeNull();
    expect(calls[0]?.params).toEqual([STUDIO, '2026-10-12T00:00:00.000Z', invoiceRow(2).id, 21]);
  });
});

describe('applyStripeEvent', () => {
  it('applies a tracked event in one call with the mapped effect', async () => {
    const { db, calls } = fakeDb(() => [{ applied: true }]);
    const result = await applyStripeEvent(
      db,
      {
        id: 'evt_1',
        type: 'customer.subscription.created',
        data: { object: { id: 'sub_1', status: 'active', metadata: { studioId: STUDIO } } },
      },
      () => '0193f000-0000-7000-8000-000000000001',
    );
    expect(result).toBe('applied');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('billing_apply_stripe_event(');
    const [eventId, eventType, effectJson] = calls[0]!.params as string[];
    expect([eventId, eventType]).toEqual(['evt_1', 'customer.subscription.created']);
    expect(JSON.parse(effectJson!)).toMatchObject({
      studioId: STUDIO,
      subscription: { stripeSubscriptionId: 'sub_1' },
      event: { type: 'billing.subscription.started' },
    });
  });

  it('reports a replay as duplicate', async () => {
    const { db } = fakeDb(() => [{ applied: false }]);
    await expect(
      applyStripeEvent(db, {
        id: 'evt_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_1', status: 'active' } },
      }),
    ).resolves.toBe('duplicate');
  });

  it('ignores untracked events without touching the database', async () => {
    const { db, calls } = fakeDb(() => []);
    await expect(
      applyStripeEvent(db, { id: 'evt_2', type: 'charge.updated', data: { object: {} } }),
    ).resolves.toBe('ignored');
    expect(calls).toHaveLength(0);
  });
});

describe('createCheckoutSession configuration gate', () => {
  const base = { DB_URL: 'postgres://x', WEB_APP_URL: 'https://studio.athlya.test' };

  it.each([
    ['dev', { ...base, ENVIRONMENT: 'dev', STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_ID_PRO: 'price' }],
    ['no secret', { ...base, ENVIRONMENT: 'staging', STRIPE_PRICE_ID_PRO: 'price' }],
    ['no price', { ...base, ENVIRONMENT: 'staging', STRIPE_SECRET_KEY: 'sk' }],
    [
      'non-https redirect',
      {
        ...base,
        ENVIRONMENT: 'staging',
        STRIPE_SECRET_KEY: 'sk',
        STRIPE_PRICE_ID_PRO: 'price',
        WEB_APP_URL: 'http://studio.athlya.test',
      },
    ],
  ])('answers not_configured (%s)', async (_label, env) => {
    const deps = buildBillingDeps(env as unknown as AthlyaBindings);
    await expect(
      deps.createCheckoutSession({ userId: 'u', studioId: STUDIO, plan: 'pro' }),
    ).resolves.toEqual({ kind: 'not_configured' });
  });
});
