'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { TurnstileWidget, type TurnstileWidgetHandle } from '../../../components/TurnstileWidget';
import { getTurnstileSiteKey } from '../../../lib/env';
import { createTranslator } from '../../../lib/i18n/t';
import { useLocale } from '../../../lib/i18n/LocaleContext';

import type { FormEvent, ReactElement } from 'react';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

interface ResetPasswordFormProps {
  readonly token: string;
  readonly nonce: string;
}

export function ResetPasswordForm({ token, nonce }: ResetPasswordFormProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (state.kind === 'submitting') return;

      if (password.length < 8 || password.length > 72) {
        setState({ kind: 'error', message: t('auth.resetPassword.errors.passwordLength') });
        return;
      }
      if (password !== confirm) {
        setState({ kind: 'error', message: t('auth.resetPassword.errors.passwordMismatch') });
        return;
      }
      if (siteKey !== undefined && turnstileToken === '') {
        setState({ kind: 'error', message: t('auth.errors.turnstileRequired') });
        return;
      }

      setState({ kind: 'submitting' });
      const consumedToken = turnstileToken;
      setTurnstileToken('');

      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (consumedToken !== '') {
          headers['cf-turnstile-token'] = consumedToken;
        }

        const res = await fetch('/api/auth/password-reset/confirm', {
          method: 'POST',
          headers,
          body: JSON.stringify({ token, newPassword: password }),
        });
        if (res.status === 204) {
          setState({ kind: 'success' });
          window.setTimeout(() => {
            window.location.assign('/login?reset=ok');
          }, 1500);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          title?: string;
          code?: string;
        };
        const code = body.code ?? body.title ?? 'unknown';
        const errorMap: Record<string, string> = {
          token_invalid: t('auth.resetPassword.errors.tokenInvalid'),
          token_expired: t('auth.resetPassword.errors.tokenExpired'),
          password_breached: t('errors.passwordBreached'),
          hibp_unavailable: t('auth.resetPassword.errors.hibpUnavailable'),
        };
        setState({
          kind: 'error',
          message: errorMap[code] ?? t('errors.generic'),
        });
        turnstileRef.current?.reset();
      } catch {
        setState({ kind: 'error', message: t('errors.network') });
        turnstileRef.current?.reset();
      }
    },
    [state.kind, password, confirm, siteKey, turnstileToken, token, t],
  );

  if (state.kind === 'success') {
    return (
      <div
        role="status"
        className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
      >
        <p>{t('auth.resetPassword.success')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" autoComplete="off">
      <label className="block">
        <span className="block text-sm font-medium">
          {t('auth.resetPassword.newPasswordLabel')}
        </span>
        <input
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <small className="block text-xs text-muted-foreground mt-1">
          {t('auth.resetPassword.hibpHint')}
        </small>
      </label>
      <label className="block">
        <span className="block text-sm font-medium">{t('auth.resetPassword.confirmLabel')}</span>
        <input
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </label>

      <TurnstileWidget
        siteKey={siteKey}
        onToken={setTurnstileToken}
        nonce={nonce}
        ref={turnstileRef}
      />

      {state.kind === 'error' && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
        >
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={state.kind === 'submitting' || (siteKey !== undefined && turnstileToken === '')}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {state.kind === 'submitting'
          ? t('auth.resetPassword.submitting')
          : t('auth.resetPassword.submit')}
      </button>
    </form>
  );
}
