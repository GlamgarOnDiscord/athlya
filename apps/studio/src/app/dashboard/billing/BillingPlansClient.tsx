/**
 * Client-side wiring for the billing plan cards (B9.3).
 *
 * Wires the previously-disabled "Souscrire" button on the `pro`
 * plan card to `POST /v1/billing/checkout`. On success the browser
 * is redirected to the Stripe Hosted Checkout URL returned by the
 * API; on `503 billing_not_configured` (mode dégradé) we surface a
 * friendly notice that Stripe is not yet provisioned for this env.
 *
 * Why a separate client component?
 * --------------------------------
 * The page itself is a Server Component (locale + static layout).
 * Only the actionable button needs the auth context + API client,
 * so we keep the surface tight here.
 *
 * @see Requirements 18.1, 18.2 (Stripe Checkout creation).
 */
'use client';

import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

import { useApiClient } from '../../../lib/api/buildClient';
import { ApiError, ApiServerError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { PLAN_KEYS, formatPlanPrice, planName } from './plan-display';

interface CheckoutResponse {
  readonly checkoutUrl: string;
}

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

export function BillingPlansClient(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const onSubscribe = useCallback(
    async (plan: 'pro') => {
      setStatus({ kind: 'loading' });
      try {
        const res = await client.post<CheckoutResponse>('/v1/billing/checkout', { plan });
        // Hard navigation — Stripe Hosted Checkout is on a
        // different origin so we cannot use Next router.
        window.location.assign(res.checkoutUrl);
      } catch (err: unknown) {
        if (err instanceof ApiServerError && err.status === 503) {
          setStatus({
            kind: 'error',
            message: t('studio.billing.checkoutNotConfigured'),
          });
          return;
        }
        if (err instanceof ApiError) {
          setStatus({
            kind: 'error',
            message: t('studio.billing.checkoutError'),
          });
          return;
        }
        setStatus({
          kind: 'error',
          message: t('studio.billing.checkoutError'),
        });
      }
    },
    [client, t],
  );

  return (
    <div className="flex flex-col gap-4">
      {status.kind === 'error' ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {status.message}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {PLAN_KEYS.map((key) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{planName(key, t)}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-2xl font-semibold">{formatPlanPrice(key, locale, t)}</p>
              <p className="text-sm text-muted-foreground">
                {t(`studio.billing.plans.${key}.body`)}
              </p>
            </CardContent>
            <CardFooter>
              {key === 'pro' ? (
                <Button
                  onClick={() => {
                    void onSubscribe('pro');
                  }}
                  disabled={status.kind === 'loading'}
                >
                  {status.kind === 'loading'
                    ? t('studio.billing.checkoutLoading')
                    : t('studio.billing.checkout')}
                </Button>
              ) : (
                <Button variant="outline" disabled>
                  {planName(key, t)}
                </Button>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
