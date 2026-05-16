/**
 * `/login` client form. Mirrors `RegisterForm.tsx` with a smaller
 * field set (email + password).
 *
 * Why a direct `fetch` rather than the shared `ApiClient`?
 * -------------------------------------------------------
 * The `ApiClient` in `src/lib/api/client.ts` attaches the in-memory
 * access token to every request and handles 401 → refresh → retry.
 * Login is the exact flow that PRODUCES the access token, so it has
 * no token to attach yet and nothing to refresh. Calling the plain
 * `fetch('/api/auth/login')` keeps the login path standalone: the
 * handler sets the refresh cookie and returns `{ accessToken }`,
 * which this component hands off to `setAccessToken()` before
 * navigating. Every subsequent authenticated call can then go
 * through the `ApiClient` as normal. `RegisterForm.tsx` follows the
 * same pattern for the same reason.
 *
 * @see Requirements 1.5, 2.3, 26.1, 26.2.
 */
'use client';

import { LoginRequestSchema } from '@athlya/shared/schemas/api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/TurnstileWidget';
import { setAccessToken } from '../../lib/auth/token-store';
import { getTurnstileSiteKey } from '../../lib/env';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import type { ProblemDetails } from '@athlya/shared/schemas';

export interface LoginFormProps {
  readonly nonce: string;
}

export function LoginForm({ nonce }: LoginFormProps): ReactElement {
  const { push } = useRouter();
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  interface LoginFormState {
    turnstileToken: string;
    email: string;
    password: string;
    error: string | null;
    pending: boolean;
  }

  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const [form, setForm] = useState<LoginFormState>(() => ({
    turnstileToken: '',
    email: '',
    password: '',
    error: null,
    pending: false,
  }));

  const onTurnstileToken = useCallback((token: string) => {
    setForm((s) => ({ ...s, turnstileToken: token }));
  }, []);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setForm((s) => ({ ...s, error: null }));

      const parsed = LoginRequestSchema.safeParse({ email: form.email, password: form.password });
      if (!parsed.success) {
        setForm((s) => ({ ...s, error: t('errors.validation') }));
        return;
      }

      if (siteKey !== undefined && form.turnstileToken === '') {
        setForm((s) => ({ ...s, error: t('auth.errors.turnstileRequired') }));
        return;
      }

      setForm((s) => ({ ...s, pending: true }));
      const consumedToken = form.turnstileToken;
      setForm((s) => ({ ...s, turnstileToken: '' }));
      try {
        const headers: HeadersInit = {
          'content-type': 'application/json',
        };
        if (consumedToken !== '') {
          (headers as Record<string, string>)['cf-turnstile-token'] = consumedToken;
        }
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers,
          body: JSON.stringify(parsed.data),
        });
        if (!response.ok) {
          let message = t('auth.errors.invalidCredentials');
          try {
            const problem = (await response.json()) as ProblemDetails;
            message = problem.detail ?? problem.title ?? message;
          } catch {
            // fall back
          }
          setForm((s) => ({ ...s, error: message }));
          turnstileRef.current?.reset();
          return;
        }
        const payload = (await response.json()) as {
          readonly accessToken: string;
        };
        setAccessToken(payload.accessToken);
        push('/');
      } catch {
        setForm((s) => ({ ...s, error: t('auth.errors.networkError') }));
        turnstileRef.current?.reset();
      } finally {
        setForm((s) => ({ ...s, pending: false }));
      }
    },
    [form, siteKey, t, push],
  );

  return (
    <form
      onSubmit={(e) => {
        void onSubmit(e);
      }}
      className="flex flex-col gap-4"
      aria-busy={form.pending}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-email">{t('auth.login.email')}</Label>
        <Input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          value={form.email}
          onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-password">{t('auth.login.password')}</Label>
        <Input
          id="login-password"
          type="password"
          required
          autoComplete="current-password"
          maxLength={72}
          value={form.password}
          onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
        />
      </div>

      <TurnstileWidget
        siteKey={siteKey}
        onToken={onTurnstileToken}
        nonce={nonce}
        ref={turnstileRef}
      />

      {form.error !== null ? (
        <span role="alert" className="text-sm text-destructive">
          {form.error}
        </span>
      ) : null}

      <Button
        type="submit"
        disabled={form.pending || (siteKey !== undefined && form.turnstileToken === '')}
      >
        {form.pending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('common.loading')}
          </>
        ) : (
          t('auth.login.submit')
        )}
      </Button>
      {/* Sprint 9 / SP9.1 (Vague 37) — lien forgot-password
                visible sur l'écran de connexion. Cible la route
                `/forgot-password` livrée Sprint 8 SP7.5. */}
      <p className="text-center text-sm">
        <Link
          href="/forgot-password"
          className="underline text-muted-foreground hover:text-foreground"
        >
          Mot de passe oublié&nbsp;?
        </Link>
      </p>
      <p className="text-center text-sm text-muted-foreground">
        {t('auth.login.noAccountPrompt')}{' '}
        <Link href="/register" className="underline hover:text-foreground">
          {t('auth.register.title')}
        </Link>
      </p>
    </form>
  );
}
