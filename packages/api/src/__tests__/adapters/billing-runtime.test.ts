import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyStripeEvent,
  buildBillingDeps,
  checkoutIdempotencyKey,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  listStudioInvoices,
  resolveBillingDbUrl,
} from '../../adapters/billing-deps.js';
import { dbHttpCache, resetAllDepsCachesForTests } from '../../adapters/deps-cache.js';

import type { AthlyaBindings } from '../../types.js';
import type { AthlyaDbAny, AthlyaDbHttp } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

/** Issue #122 — billing adapters over the 0036 functions. */

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111113';
const CLAIMS = { userId: ADMIN, studioId: STUDIO, role: 'admin' as const };
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

/** Neon HTTP double: `batch` runs the queued statements in one round-trip. */
function fakeHttpDb(rows: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute(query: SQL) {
      return dialect.sqlToQuery(query);
    },
    batch(items: Array<{ sql: string; params: unknown[] }>) {
      calls.push(...items);
      return Promise.resolve(items.map((_, i) => ({ rows: i === items.length - 1 ? rows : [] })));
    },
  };
  return { db: db as unknown as AthlyaDbHttp, calls };
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

  it('rejects a tampered id that is not a hyphenated UUID', () => {
    const dashes = '-'.repeat(36);
    expect(decodeInvoiceCursor(btoa(`2026-10-12T00:00:00.000Z|${dashes}`))).toBeNull();
    expect(
      decodeInvoiceCursor(btoa('2026-10-12T00:00:00.000Z|0193f0000000-7000-8000-0000000000001')),
    ).toBeNull();
  });

  it('normalises the timestamp to ISO before it reaches the cast', () => {
    expect(
      decodeInvoiceCursor(btoa(`2026-10-12T02:00:00+02:00|${invoiceRow(1).id.toUpperCase()}`)),
    ).toEqual({ createdAt: '2026-10-12T00:00:00.000Z', id: invoiceRow(1).id });
  });
});

describe('listStudioInvoices', () => {
  it('maps rows to the API projection and emits a next cursor on overflow', async () => {
    const { db, calls } = fakeHttpDb([invoiceRow(3), invoiceRow(2), invoiceRow(1)]);
    const page = await listStudioInvoices(db, CLAIMS, { limit: 2 });

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
    // Tenant claims are set in the same batch: RLS scopes the listing.
    expect(calls.slice(0, 3).map((c) => [c.sql.match(/app\.\w+/u)?.[0], ...c.params])).toEqual([
      ['app.user_id', ADMIN],
      ['app.studio_id', STUDIO],
      ['app.role', 'admin'],
    ]);
    expect(calls[3]?.sql).toContain('billing_list_invoices(');
    expect(calls[3]?.params).toEqual([STUDIO, null, null, 3]);
  });

  it('passes the decoded cursor and returns no cursor on the last page', async () => {
    const { db, calls } = fakeHttpDb([invoiceRow(1)]);
    const cursor = encodeInvoiceCursor('2026-10-12T00:00:00.000Z', invoiceRow(2).id);
    const page = await listStudioInvoices(db, CLAIMS, { cursor, limit: 20 });
    expect(page.nextCursor).toBeNull();
    expect(calls[3]?.params).toEqual([STUDIO, '2026-10-12T00:00:00.000Z', invoiceRow(2).id, 21]);
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

describe('createCheckoutSession when configured', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAllDepsCachesForTests();
  });

  it('creates the Stripe session with a request-scoped idempotency key', async () => {
    const env = {
      ENVIRONMENT: 'staging',
      DB_URL: 'postgres://billing-configured',
      WEB_APP_URL: 'https://studio.athlya.test',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_PRICE_ID_PRO: 'price_pro',
    };
    const { db } = fakeDb(() => [
      { id: ADMIN, studio_id: STUDIO, email: 'admin@athlya.test', deleted_at: null },
    ]);
    dbHttpCache.set(env.DB_URL, db as unknown as AthlyaDbHttp);
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const deps = buildBillingDeps(env as unknown as AthlyaBindings);
    const input = { userId: ADMIN, studioId: STUDIO, plan: 'pro' as const, idempotencyKey: 'k-1' };
    await expect(deps.createCheckoutSession(input)).resolves.toEqual({
      kind: 'ok',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    await deps.createCheckoutSession(input);

    const keys = fetchMock.mock.calls.map(
      ([, init]) => (init.headers as Record<string, string>)['idempotency-key'],
    );
    expect(keys[0]).toBe(await checkoutIdempotencyKey(input));
    expect(keys[1]).toBe(keys[0]);
    const form = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1].body));
    expect(form.get('metadata[studioId]')).toBe(STUDIO);
    expect(form.get('success_url')).toMatch(/^https:\/\/studio\.athlya\.test\/billing\/success/u);
  });

  it('answers user_not_found for an account anonymised by the RGPD purge (issue #628)', async () => {
    const env = {
      ENVIRONMENT: 'staging',
      DB_URL: 'postgres://billing-anonymised',
      WEB_APP_URL: 'https://studio.athlya.test',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_PRICE_ID_PRO: 'price_pro',
    };
    const { db } = fakeDb(() => [{ id: ADMIN, studio_id: STUDIO, email: null, deleted_at: null }]);
    dbHttpCache.set(env.DB_URL, db as unknown as AthlyaDbHttp);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deps = buildBillingDeps(env as unknown as AthlyaBindings);

    await expect(
      deps.createCheckoutSession({ userId: ADMIN, studioId: STUDIO, plan: 'pro' }),
    ).resolves.toEqual({ kind: 'user_not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('checkoutIdempotencyKey', () => {
  it('scopes the client key to the studio and admin', async () => {
    const a = await checkoutIdempotencyKey({
      studioId: STUDIO,
      userId: ADMIN,
      idempotencyKey: 'k',
    });
    const b = await checkoutIdempotencyKey({
      studioId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: ADMIN,
      idempotencyKey: 'k',
    });
    expect(a).toMatch(/^studio-checkout:[0-9a-f]{64}$/u);
    expect(b).not.toBe(a);
  });

  it('uses a fresh key when the client sent none', async () => {
    await expect(
      checkoutIdempotencyKey({ studioId: STUDIO, userId: ADMIN }, () => 'fresh'),
    ).resolves.toBe('studio-checkout:fresh');
  });
});

describe('resolveBillingDbUrl', () => {
  it('uses the athlya_billing connection when configured', () => {
    expect(
      resolveBillingDbUrl({
        ENVIRONMENT: 'production',
        DB_URL: 'postgres://app',
        BILLING_DB_URL: 'postgres://billing',
      }),
    ).toBe('postgres://billing');
  });

  it('never falls back to the athlya_app connection outside dev', () => {
    expect(resolveBillingDbUrl({ ENVIRONMENT: 'production', DB_URL: 'postgres://app' })).toBeNull();
    expect(
      resolveBillingDbUrl({
        ENVIRONMENT: 'staging',
        DB_URL: 'postgres://app',
        BILLING_DB_URL: ' ',
      }),
    ).toBeNull();
    expect(resolveBillingDbUrl({ ENVIRONMENT: 'dev', DB_URL: 'postgres://app' })).toBe(
      'postgres://app',
    );
  });
});
