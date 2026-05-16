/**
 * Unit tests for `@athlya/billing/service`.
 *
 * Covers the happy path plus every skip / error branch of
 * {@link createCheckoutSession}:
 *
 *   - Happy path: Stripe called once with the full params including
 *     `stripeAccount`, `customerEmail` and per-member metadata.
 *   - `user_not_found`       when the user lookup returns `null`
 *                            (Stripe MUST NOT be called — sensitive
 *                            outbound call skipped for unknown ids).
 *   - `billing_not_configured` when the studio row is missing entirely.
 *   - `billing_not_configured` when the studio exists but has not
 *                            completed Stripe onboarding
 *                            (`stripeAccountId === null`).
 *   - Zod rejects a non-HTTPS `successUrl` with a `ZodError`.
 *   - Zod rejects an empty `priceId` with a `ZodError`.
 *   - A thrown Stripe error propagates unchanged (no swallowing).
 *
 * Every dependency is a hand-rolled `vi.fn()` double — no network,
 * no Stripe SDK. Matches the style used in
 * `packages/notifications/src/__tests__/consumer.test.ts`.
 *
 * Validates: Requirement 18.1
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import { ZodError } from 'zod';

import {
    createCheckoutSession,
    type CheckoutSession,
    type CreateCheckoutSessionDeps,
    type CreateCheckoutSessionInput,
    type StripeClient,
    type StudioBilling,
    type StudioBillingRepo,
    type UserBillingContext,
    type UserLookupRepo,
} from '../service.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = 'c3d4e5f6-789a-4cde-abef-34567890abcd';
const STUDIO_ID = 'b2c3d4e5-6789-4bcd-9aef-234567890abc';
const STRIPE_ACCOUNT_ID = 'acct_1Test000000';
const PRICE_ID = 'price_monthly_basic';
const SESSION_ID = 'cs_test_abc123';
const SESSION_URL = 'https://checkout.stripe.com/c/pay/cs_test_abc123';
const SUCCESS_URL = 'https://app.athlya.test/billing/success';
const CANCEL_URL = 'https://app.athlya.test/billing/cancel';

const BASE_USER: UserBillingContext = {
    userId: USER_ID,
    email: 'member@example.com',
    studioId: STUDIO_ID,
};

const BASE_BILLING: StudioBilling = {
    studioId: STUDIO_ID,
    stripeAccountId: STRIPE_ACCOUNT_ID,
};

const BASE_INPUT: CreateCheckoutSessionInput = {
    userId: USER_ID,
    priceId: PRICE_ID,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
};

/* ------------------------------------------------------------------ */
/*  Deps builder                                                       */
/* ------------------------------------------------------------------ */

interface DepsHandles {
    readonly getUser: Mock<UserLookupRepo['getUser']>;
    readonly getBilling: Mock<StudioBillingRepo['getBilling']>;
    readonly createStripeSession: Mock<StripeClient['createCheckoutSession']>;
    readonly deps: CreateCheckoutSessionDeps;
}

function buildDeps(
    options: {
        user?: UserBillingContext | null;
        billing?: StudioBilling | null;
        session?: CheckoutSession;
        sessionError?: Error;
    } = {},
): DepsHandles {
    const user = options.user === undefined ? BASE_USER : options.user;
    const billing =
        options.billing === undefined ? BASE_BILLING : options.billing;
    const session: CheckoutSession = options.session ?? {
        id: SESSION_ID,
        url: SESSION_URL,
    };

    const getUser = vi
        .fn<UserLookupRepo['getUser']>()
        .mockResolvedValue(user);
    const getBilling = vi
        .fn<StudioBillingRepo['getBilling']>()
        .mockResolvedValue(billing);

    const createStripeSession = vi.fn<StripeClient['createCheckoutSession']>();
    if (options.sessionError !== undefined) {
        createStripeSession.mockRejectedValue(options.sessionError);
    } else {
        createStripeSession.mockResolvedValue(session);
    }

    return {
        getUser,
        getBilling,
        createStripeSession,
        deps: {
            users: { getUser },
            billing: { getBilling },
            stripe: { createCheckoutSession: createStripeSession },
        },
    };
}

/* ================================================================== */
/*  Happy path                                                         */
/* ================================================================== */

describe('createCheckoutSession — happy path', () => {
    it('creates a session scoped to the studio Stripe account', async () => {
        const { getUser, getBilling, createStripeSession, deps } = buildDeps();

        const result = await createCheckoutSession(BASE_INPUT, deps);

        expect(result).toEqual({
            kind: 'ok',
            sessionId: SESSION_ID,
            url: SESSION_URL,
        });

        // Repos were consulted in order.
        expect(getUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
        expect(getBilling).toHaveBeenCalledExactlyOnceWith(STUDIO_ID);

        // Stripe was called once with the full params — Connect
        // account id, customer email pre-fill, and metadata carrying
        // both correlation keys the webhook will need.
        expect(createStripeSession).toHaveBeenCalledExactlyOnceWith({
            priceId: PRICE_ID,
            successUrl: SUCCESS_URL,
            cancelUrl: CANCEL_URL,
            customerEmail: 'member@example.com',
            metadata: {
                userId: USER_ID,
                studioId: STUDIO_ID,
            },
            stripeAccount: STRIPE_ACCOUNT_ID,
        });
    });
});

/* ================================================================== */
/*  user_not_found                                                     */
/* ================================================================== */

describe('createCheckoutSession — user_not_found', () => {
    it('short-circuits and does NOT call Stripe when the user is missing', async () => {
        const { getBilling, createStripeSession, deps } = buildDeps({
            user: null,
        });

        const result = await createCheckoutSession(BASE_INPUT, deps);

        expect(result).toEqual({ kind: 'user_not_found' });

        // Billing lookup and Stripe are both skipped to avoid a
        // useless outbound call for an unknown user id.
        expect(getBilling).not.toHaveBeenCalled();
        expect(createStripeSession).not.toHaveBeenCalled();
    });
});

/* ================================================================== */
/*  billing_not_configured                                             */
/* ================================================================== */

describe('createCheckoutSession — billing_not_configured', () => {
    it('returns billing_not_configured when the studio row is missing', async () => {
        const { createStripeSession, deps } = buildDeps({ billing: null });

        const result = await createCheckoutSession(BASE_INPUT, deps);

        expect(result).toEqual({ kind: 'billing_not_configured' });
        expect(createStripeSession).not.toHaveBeenCalled();
    });

    it('returns billing_not_configured when stripeAccountId is null', async () => {
        const { createStripeSession, deps } = buildDeps({
            billing: { studioId: STUDIO_ID, stripeAccountId: null },
        });

        const result = await createCheckoutSession(BASE_INPUT, deps);

        expect(result).toEqual({ kind: 'billing_not_configured' });
        expect(createStripeSession).not.toHaveBeenCalled();
    });
});

/* ================================================================== */
/*  Input validation                                                   */
/* ================================================================== */

describe('createCheckoutSession — input validation', () => {
    it('throws ZodError when successUrl is not HTTPS', async () => {
        const { deps } = buildDeps();

        await expect(
            createCheckoutSession(
                { ...BASE_INPUT, successUrl: 'http://insecure.example/' },
                deps,
            ),
        ).rejects.toBeInstanceOf(ZodError);
    });

    it('throws ZodError when cancelUrl is not HTTPS', async () => {
        const { deps } = buildDeps();

        await expect(
            createCheckoutSession(
                { ...BASE_INPUT, cancelUrl: 'ftp://nope.example/' },
                deps,
            ),
        ).rejects.toBeInstanceOf(ZodError);
    });

    it('throws ZodError when priceId is empty', async () => {
        const { deps } = buildDeps();

        await expect(
            createCheckoutSession({ ...BASE_INPUT, priceId: '' }, deps),
        ).rejects.toBeInstanceOf(ZodError);
    });

    it('throws ZodError when userId is empty', async () => {
        const { deps } = buildDeps();

        await expect(
            createCheckoutSession({ ...BASE_INPUT, userId: '' }, deps),
        ).rejects.toBeInstanceOf(ZodError);
    });
});

/* ================================================================== */
/*  Stripe error propagation                                           */
/* ================================================================== */

describe('createCheckoutSession — Stripe error propagation', () => {
    it('propagates thrown Stripe errors (no swallowing)', async () => {
        const stripeError = new Error('Stripe API down: 502');
        const { deps } = buildDeps({ sessionError: stripeError });

        await expect(
            createCheckoutSession(BASE_INPUT, deps),
        ).rejects.toBe(stripeError);
    });
});
