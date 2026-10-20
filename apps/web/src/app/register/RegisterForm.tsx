/**
 * `/register` client form.
 *
 * Uses the shared Zod schema (`RegisterRequestSchema`) to validate the
 * payload before POSTing to `/api/auth/register`. When
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is provisioned, the form blocks
 * submission until the user clears the challenge.
 *
 * Strings resolve through `createTranslator(locale)`.
 *
 * @see Requirements 1.1, 1.2, 3.3, 26.1, 26.2.
 */
'use client';

import { RegisterRequestSchema } from '@athlya/shared/schemas/api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CircleNotchIcon } from '@phosphor-icons/react';

import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/TurnstileWidget';
import { postAuthDestination } from '../../lib/auth/post-auth-destination';
import { setAccessToken } from '../../lib/auth/token-store';
import { getTurnstileSiteKey } from '../../lib/env';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import type { ProblemDetails } from '@athlya/shared/schemas';

export interface RegisterFormProps {
  /** CSP nonce forwarded to the Turnstile `<script>` tag. */
  readonly nonce: string;
}

interface FormState {
  email: string;
  password: string;
  displayName: string;
  studioSlug: string;
  consents: {
    marketing: boolean;
    analytics: boolean;
    thirdParty: boolean;
  };
}

const initialState: FormState = {
  email: '',
  password: '',
  displayName: '',
  studioSlug: '',
  consents: { marketing: false, analytics: false, thirdParty: false },
};

export function RegisterForm({ nonce }: RegisterFormProps): ReactElement {
  const { push } = useRouter();
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [state, setState] = useState<FormState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);

      // Client-side Zod validation — mirrors the shared schema
      // so the server's 422 path only fires on truly invalid
      // payloads a client-side bypass snuck through.
      const parsed = RegisterRequestSchema.safeParse(state);
      if (!parsed.success) {
        setError(t('errors.validation'));
        return;
      }

      if (siteKey !== undefined && turnstileToken === '') {
        setError(t('auth.errors.turnstileRequired'));
        return;
      }

      setPending(true);
      // Capture the token in a local const and clear it from
      // React state immediately — Turnstile tokens are
      // single-use; see the matching comment in `LoginForm.tsx`
      // for the full rationale.
      const consumedToken = turnstileToken;
      setTurnstileToken('');
      try {
        const headers: HeadersInit = {
          'content-type': 'application/json',
        };
        if (consumedToken !== '') {
          (headers as Record<string, string>)['cf-turnstile-token'] = consumedToken;
        }
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers,
          body: JSON.stringify(parsed.data),
        });
        if (!response.ok) {
          let message = t('errors.generic');
          try {
            const problem = (await response.json()) as ProblemDetails;
            message = problem.detail ?? problem.title ?? message;
          } catch {
            // fall back to generic
          }
          setError(message);
          // Turnstile tokens are single-use; force a fresh
          // challenge so the retry is not rejected as
          // `timeout-or-duplicate`.
          turnstileRef.current?.reset();
          return;
        }
        const payload = (await response.json()) as {
          readonly accessToken: string;
        };
        setAccessToken(payload.accessToken);
        push(postAuthDestination(window.location.search));
      } catch {
        setError(t('auth.errors.networkError'));
        turnstileRef.current?.reset();
      } finally {
        setPending(false);
      }
    },
    [state, siteKey, turnstileToken, t, push],
  );

  return (
    <form
      // Sync wrapper around the async `onSubmit` — satisfies
      // `FormEventHandler<HTMLFormElement>`'s `void` contract
      // (async handlers return `Promise<void>`, which
      // `@typescript-eslint/no-misused-promises` flags when
      // passed directly to a JSX attribute). `void` discards
      // the promise; errors inside `onSubmit` surface via the
      // `error` state on the form.
      onSubmit={(e) => {
        void onSubmit(e);
      }}
      className="flex flex-col gap-4"
      aria-busy={pending}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reg-email">{t('auth.register.email')}</Label>
        <Input
          id="reg-email"
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          value={state.email}
          onChange={(e) => setState((s) => ({ ...s, email: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reg-password">{t('auth.register.password')}</Label>
        <Input
          id="reg-password"
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
          value={state.password}
          onChange={(e) => setState((s) => ({ ...s, password: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reg-display-name">{t('auth.register.displayName')}</Label>
        <Input
          id="reg-display-name"
          type="text"
          required
          maxLength={80}
          value={state.displayName}
          onChange={(e) => setState((s) => ({ ...s, displayName: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reg-studio-slug">{t('auth.register.studioSlug')}</Label>
        <Input
          id="reg-studio-slug"
          type="text"
          required
          pattern="[a-z0-9-]{3,50}"
          maxLength={50}
          value={state.studioSlug}
          onChange={(e) => setState((s) => ({ ...s, studioSlug: e.target.value }))}
        />
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
        <legend className="sr-only">{t('auth.register.consents.legend')}</legend>
        <div className="flex items-center gap-2">
          <Checkbox
            id="reg-consent-marketing"
            aria-labelledby="reg-consent-marketing-label"
            checked={state.consents.marketing}
            onCheckedChange={(checked) =>
              setState((s) => ({
                ...s,
                consents: { ...s.consents, marketing: checked === true },
              }))
            }
          />
          <Label
            id="reg-consent-marketing-label"
            htmlFor="reg-consent-marketing"
            className="text-sm font-normal"
          >
            {t('auth.register.consents.marketing')}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="reg-consent-analytics"
            aria-labelledby="reg-consent-analytics-label"
            checked={state.consents.analytics}
            onCheckedChange={(checked) =>
              setState((s) => ({
                ...s,
                consents: { ...s.consents, analytics: checked === true },
              }))
            }
          />
          <Label
            id="reg-consent-analytics-label"
            htmlFor="reg-consent-analytics"
            className="text-sm font-normal"
          >
            {t('auth.register.consents.analytics')}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="reg-consent-thirdParty"
            aria-labelledby="reg-consent-thirdParty-label"
            checked={state.consents.thirdParty}
            onCheckedChange={(checked) =>
              setState((s) => ({
                ...s,
                consents: { ...s.consents, thirdParty: checked === true },
              }))
            }
          />
          <Label
            id="reg-consent-thirdParty-label"
            htmlFor="reg-consent-thirdParty"
            className="text-sm font-normal"
          >
            {t('auth.register.consents.thirdParty')}
          </Label>
        </div>
      </fieldset>

      <TurnstileWidget
        siteKey={siteKey}
        onToken={setTurnstileToken}
        nonce={nonce}
        ref={turnstileRef}
      />

      {error !== null ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}

      <Button type="submit" disabled={pending || (siteKey !== undefined && turnstileToken === '')}>
        {pending ? (
          <>
            <CircleNotchIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </>
        ) : (
          t('auth.register.submit')
        )}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t('auth.register.hasAccountPrompt')}{' '}
        <Link href="/login" className="underline hover:text-foreground">
          {t('auth.login.title')}
        </Link>
      </p>
    </form>
  );
}
