'use client';

import { useMemo, useRef, useState } from 'react';

import { TurnstileWidget, type TurnstileWidgetHandle } from '../../components/TurnstileWidget';
import { getTurnstileSiteKey } from '../../lib/env';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import type { FormEvent, ReactElement } from 'react';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export interface ForgotPasswordFormProps {
  /**
   * CSP nonce forwarded to {@link TurnstileWidget} so the inline
   * script Cloudflare injects can pass the gateway's strict
   * `script-src 'nonce-…'` policy. Provided by the page server
   * component.
   */
  readonly nonce: string;
}

/**
 * 1-step forgot-password form. Sprint 8 SP7.5 + Sprint 12 / Slice
 * 13.1 (SP8.4) — Turnstile widget câblé pour bloquer l'abus de
 * `/v1/auth/password-reset/request` par des scripts.
 *
 * Posture security: l'API répond 204 unconditionnellement
 * (email-enumeration defence). Le formulaire reflète ce flou — un
 * succès UI ne révèle pas si l'email existe en base.
 */
export function ForgotPasswordForm({ nonce }: ForgotPasswordFormProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const siteKey = getTurnstileSiteKey();
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const turnstileToken = useRef<string>('');

  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state.kind === 'submitting') return;

    setState({ kind: 'submitting' });
    try {
      // Sprint 12 / Slice 13.1 — Turnstile token consumed once
      // per submit. The next attempt requires a fresh
      // challenge — the widget reset is triggered in the
      // error/finally arms below.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (turnstileToken.current !== '') {
        headers['cf-turnstile-token'] = turnstileToken.current;
      }

      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email }),
      });
      if (res.status === 204) {
        setState({ kind: 'sent' });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        title?: string;
        code?: string;
      };
      setState({
        kind: 'error',
        message: body.title ?? body.code ?? t('auth.forgotPassword.errors.generic'),
      });
      turnstileRef.current?.reset();
      turnstileToken.current = '';
    } catch {
      setState({
        kind: 'error',
        message: t('errors.network'),
      });
      turnstileRef.current?.reset();
      turnstileToken.current = '';
    }
  };

  if (state.kind === 'sent') {
    return (
      <div
        role="status"
        className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
      >
        <p>{t('auth.forgotPassword.sent')}</p>
        <p className="mt-2">{t('auth.forgotPassword.sentSpam')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="block text-sm font-medium">{t('auth.forgotPassword.emailLabel')}</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          placeholder={t('auth.forgotPassword.emailPlaceholder')}
        />
      </label>

      <TurnstileWidget
        siteKey={siteKey}
        onToken={(token) => {
          turnstileToken.current = token;
        }}
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
        disabled={state.kind === 'submitting'}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {state.kind === 'submitting'
          ? t('auth.forgotPassword.submitting')
          : t('auth.forgotPassword.submit')}
      </button>
    </form>
  );
}
