/**
 * Unit tests for the `/v1/billing/*` domain router â€” slice B9.3, B9.4, B9.5.
 *
 * Covers:
 *   1. `POST /checkout` without auth â†’ 401.
 *   2. `POST /checkout` with member role â†’ 403 forbidden.
 *   3. `POST /checkout` with admin + `not_configured` deps â†’ 503.
 *   4. `GET /invoices` with admin â†’ empty page (mode dÃ©gradÃ©).
 *   5. `POST /webhook` without `Stripe-Signature` â†’ 400 invalid_signature.
 *   6. `POST /webhook` with `Stripe-Signature` and ok deps â†’ 200.
 *   7. `POST /webhook` does NOT carry jwtAuth (no 401 even without bearer).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';

import {
    buildLocalResolver,
    buildMockEnv,
    buildStubDeps,
    env,
    mintTestKeypair,
    signTestJwt,
    TEST_STUDIO_ID,
    TEST_USER_ID,
    type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';

const joseHoisted = vi.hoisted(() => ({
    localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
    const actual = await vi.importActual<typeof import('jose')>('jose');
    return {
        ...actual,
        createRemoteJWKSet: () =>
            (async (...args: Parameters<JwksKeyResolver>) => {
                if (joseHoisted.localResolver === null) {
                    throw new Error('local resolver not initialised');
                }
                return joseHoisted.localResolver(...args);
            }) as JwksKeyResolver,
    };
});

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
    kp = await mintTestKeypair();
    resolver = buildLocalResolver(kp.publicJwk);
    joseHoisted.localResolver = resolver;
});

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    __resetJwksCacheForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

function buildAppWithDeps(deps: DomainDeps) {
    return buildApp({ deps });
}

describe('POST /v1/billing/checkout', () => {
    it('rejects unauthenticated requests with 401', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/checkout',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plan: 'pro' }),
            },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.billing.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('rejects member role with 403', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/billing/checkout',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ plan: 'pro' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(403);
        expect(deps.billing.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('returns 503 with billing_not_configured when Stripe is absent', async () => {
        const deps = buildStubDeps({
            billing: {
                createCheckoutSession: vi.fn(async () => ({
                    kind: 'not_configured' as const,
                })),
            },
        });
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/billing/checkout',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ plan: 'pro' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(503);
        const body = await res.json() as Record<string, unknown>;
        expect(body.code).toBe('billing_not_configured');
        expect(deps.billing.createCheckoutSession).toHaveBeenCalledWith({
            userId: TEST_USER_ID,
            studioId: TEST_STUDIO_ID,
            plan: 'pro',
        });
    });

    it('returns the checkoutUrl on a happy-path adapter', async () => {
        const deps = buildStubDeps({
            billing: {
                createCheckoutSession: vi.fn(async () => ({
                    kind: 'ok' as const,
                    checkoutUrl: 'https://checkout.stripe.com/cs_test_abc',
                })),
            },
        });
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/billing/checkout',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ plan: 'pro' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.checkoutUrl).toBe('https://checkout.stripe.com/cs_test_abc');
    });

    it('rejects an invalid plan with 422 ValidationError', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/billing/checkout',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ plan: 'enterprise' }),
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(422);
        expect(deps.billing.createCheckoutSession).not.toHaveBeenCalled();
    });
});

describe('GET /v1/billing/invoices', () => {
    it('rejects unauthenticated with 401', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/invoices',
            { method: 'GET' },
            env(),
        );

        expect(res.status).toBe(401);
        expect(deps.billing.listInvoices).not.toHaveBeenCalled();
    });

    it('rejects member role with 403', async () => {
        const deps = buildStubDeps();
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'member',
        });

        const res = await app.request(
            '/v1/billing/invoices',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(403);
    });

    it('returns the deps payload as-is for admins (mode dÃ©gradÃ© empty page)', async () => {
        const deps = buildStubDeps({
            billing: {
                listInvoices: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                })),
            },
        });
        const app = buildAppWithDeps(deps);
        const token = await signTestJwt(kp.privateKey, {
            sub: TEST_USER_ID,
            studio: TEST_STUDIO_ID,
            role: 'admin',
        });

        const res = await app.request(
            '/v1/billing/invoices',
            {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual({ items: [], nextCursor: null });
    });
});

describe('POST /v1/billing/webhook', () => {
    it('rejects without Stripe-Signature header with 400 invalid_signature', async () => {
        const deps = buildStubDeps({
            billing: {
                handleWebhook: vi.fn(async ({ signature }) =>
                    signature === null
                        ? { kind: 'signature_invalid' as const }
                        : { kind: 'ok' as const },
                ),
            },
        });
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/webhook',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"id":"evt_test","type":"customer.subscription.created"}',
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(400);
        const body = await res.json() as Record<string, unknown>;
        expect(body.code).toBe('invalid_signature');
    });

    it('returns 200 when handleWebhook resolves ok', async () => {
        const deps = buildStubDeps({
            billing: {
                handleWebhook: vi.fn(async () => ({ kind: 'ok' as const })),
            },
        });
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/webhook',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'stripe-signature': 't=1,v1=abc',
                },
                body: '{"id":"evt_test","type":"customer.subscription.created"}',
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
        expect(deps.billing.handleWebhook).toHaveBeenCalledWith({
            rawPayload:
                '{"id":"evt_test","type":"customer.subscription.created"}',
            signature: 't=1,v1=abc',
        });
    });

    it('returns 200 in mode dÃ©gradÃ© (not_configured) so Stripe stops retrying', async () => {
        const deps = buildStubDeps({
            billing: {
                handleWebhook: vi.fn(async () => ({
                    kind: 'not_configured' as const,
                })),
            },
        });
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/webhook',
            {
                method: 'POST',
                headers: { 'stripe-signature': 't=1,v1=abc' },
                body: '{"id":"evt_test"}',
            },
            buildMockEnv(),
        );

        expect(res.status).toBe(200);
    });

    it('does NOT require an Authorization header (Stripe webhooks are not bearer-authenticated)', async () => {
        const deps = buildStubDeps({
            billing: {
                handleWebhook: vi.fn(async () => ({ kind: 'ok' as const })),
            },
        });
        const app = buildAppWithDeps(deps);

        const res = await app.request(
            '/v1/billing/webhook',
            {
                method: 'POST',
                headers: { 'stripe-signature': 't=1,v1=abc' },
                body: '{"id":"evt"}',
            },
            buildMockEnv(),
        );

        // 401 would mean jwtAuth is wrongly applied. Accept ok or any
        // 2xx â€” the contract is "no 401".
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(200);
    });
});
