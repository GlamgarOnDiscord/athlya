/**
 * One-click sign-in of a demo build (issue #750), shown on `/login` in
 * place of the credentials form: no password, no Turnstile, no refresh
 * cookie. The login goes through `useAuth().login`, which the demo
 * transport answers from the fake API.
 */
'use client';

import { UserIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactElement } from 'react';

import { useAuth } from '../../lib/auth/AuthContext';
import { postAuthDestination } from '../../lib/auth/post-auth-destination';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

const DEMO_MEMBER = { name: 'Léa Fontaine', email: 'lea.fontaine@example.com' } as const;

export function DemoRolePicker(): ReactElement | null {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { login } = useAuth();
  const { push } = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return null;

  async function signIn(): Promise<void> {
    setPending(true);
    setFailed(false);
    try {
      await login({ email: DEMO_MEMBER.email, password: 'demo' });
      push(postAuthDestination(window.location.search));
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="demo-picker-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="demo-picker-title" className="text-base font-semibold">
          {t('demo.picker.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('demo.picker.subtitle')}</p>
      </div>
      <button
        type="button"
        disabled={pending}
        aria-label={t('demo.picker.signInAs', {
          name: DEMO_MEMBER.name,
          role: t('demo.picker.member'),
        })}
        onClick={() => {
          void signIn();
        }}
        className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
          <UserIcon size={20} aria-hidden="true" />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-medium">
            {DEMO_MEMBER.name} · {t('demo.picker.member')}
          </span>
          <span className="text-xs text-muted-foreground">{t('demo.picker.memberHint')}</span>
        </span>
      </button>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('demo.picker.error')}
        </p>
      ) : null}
    </section>
  );
}
