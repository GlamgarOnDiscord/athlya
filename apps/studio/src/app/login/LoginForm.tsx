/**
 * `/login` client form for the studio console (every staff role). Opened
 * from a team invitation link, it accepts the invitation right after the
 * sign-in and refreshes the session so the new role applies at once.
 *
 * Minimal copy of `apps/web/src/app/login/LoginForm.tsx` without the
 * Turnstile widget. The studio admin login is gated by the same API
 * Turnstile middleware in production; until 12.B wires the widget
 * here, deployments must run with `TURNSTILE_SECRET` set or the
 * gateway will reject every login. In local dev (no
 * `TURNSTILE_SECRET`), the gateway bypasses Turnstile per its
 * dev-only flag, so login works out of the box.
 *
 * Why no Turnstile in 12.A?
 * -------------------------
 * The widget itself is non-trivial (~200 lines of effects + ref
 * forwarding + reset semantics). Copying it now would inflate this
 * slice without buying a working flow — admin /login is still
 * usable in local dev, and re-using the existing widget lives in
 * 12.B once the studio classes/members UI demands a third Turnstile
 * site.
 *
 * @see Requirements 1.5, 2.3.
 */
'use client';

import { LoginRequestSchema } from '@athlya/shared/schemas/api';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/TurnstileWidget';
import { useApiClient } from '../../lib/api/buildClient';
import { ApiError } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthContext';
import { readInviteToken } from '../../lib/auth/invite';
import { canUseStudio } from '../../lib/auth/studio-access';
import { getAccessToken } from '../../lib/auth/token-store';
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
  const { login, logout, refreshSession } = useAuth();
  const client = useApiClient(getAccessToken);
  // A team invitation link carries its token in the fragment (issue #756);
  // read after mount so the server render and the first client render match.
  const [invite, setInvite] = useState<string | null>(null);
  useEffect(() => {
    setInvite(readInviteToken(window.location.hash));
  }, []);

  interface FormState {
    turnstileToken: string;
    email: string;
    password: string;
    error: string | null;
    pending: boolean;
  }

  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const [form, setForm] = useState<FormState>(() => ({
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
        const session = await login({
          email: form.email,
          password: form.password,
          turnstileToken: consumedToken,
        });
        let role = session.user.role;
        if (invite !== null) {
          try {
            await client.post('/v1/studios/me/team/invitations/accept', { token: invite });
          } catch (err) {
            await logout().catch(() => undefined);
            setForm((s) => ({
              ...s,
              error: t(
                err instanceof ApiError && err.status === 404
                  ? 'studio.login.invite.invalid'
                  : 'auth.errors.networkError',
              ),
            }));
            turnstileRef.current?.reset();
            return;
          }
          // The invitation is spent: a retry signs in without it.
          window.history.replaceState(null, '', window.location.pathname);
          setInvite(null);
          // The access token still carries the previous role. Without a fresh
          // session the new role is unknown, and a second sign-in reads it.
          const refreshed = await refreshSession();
          if (refreshed === null) {
            await logout().catch(() => undefined);
            setForm((s) => ({ ...s, error: t('auth.errors.networkError') }));
            turnstileRef.current?.reset();
            return;
          }
          role = refreshed.role;
        }
        if (!canUseStudio(role)) {
          // A member is refused, and the session this sign-in just opened is closed
          // (a failed sign-out still clears the local token).
          await logout().catch(() => undefined);
          setForm((s) => ({ ...s, error: t('studio.login.staffRequired') }));
          turnstileRef.current?.reset();
          return;
        }
        push('/dashboard');
      } catch (err) {
        const status = (err as { status?: number }).status;
        const body = (err as { body?: ProblemDetails }).body;
        if (status === 401) {
          setForm((s) => ({ ...s, error: t('auth.errors.invalidCredentials') }));
        } else if (body?.detail !== undefined) {
          setForm((s) => ({ ...s, error: body.detail ?? null }));
        } else if (body?.title !== undefined) {
          setForm((s) => ({ ...s, error: body.title ?? null }));
        } else {
          setForm((s) => ({ ...s, error: t('auth.errors.networkError') }));
        }
        turnstileRef.current?.reset();
      } finally {
        setForm((s) => ({ ...s, pending: false }));
      }
    },
    [form, siteKey, login, logout, refreshSession, client, invite, push, t],
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
      {invite !== null ? (
        <p className="rounded-lg border border-border bg-muted p-3 text-sm">
          {t('studio.login.invite.notice')}
        </p>
      ) : null}
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
        <span role="alert" aria-live="polite" className="text-sm text-destructive">
          {form.error}
        </span>
      ) : null}

      <Button
        type="submit"
        disabled={form.pending || (siteKey !== undefined && form.turnstileToken === '')}
      >
        {t('auth.login.submit')}
      </Button>
    </form>
  );
}
