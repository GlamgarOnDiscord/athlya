/**
 * One-click sign-in of a demo build (issue #750), shown on `/login` in
 * place of the credentials form: no password, no Turnstile, no refresh
 * cookie. The login goes through `useAuth().login`, which the demo
 * transport answers from the fake API.
 */
'use client';

import { ChalkboardTeacherIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactElement } from 'react';

import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

const DEMO_PROFILES = [
  {
    key: 'admin',
    name: 'Camille Durand',
    email: 'camille.durand@example.com',
    Icon: ShieldCheckIcon,
  },
  {
    key: 'coach',
    name: 'Inès Garnier',
    email: 'ines.garnier@example.com',
    Icon: ChalkboardTeacherIcon,
  },
] as const;

type ProfileKey = (typeof DEMO_PROFILES)[number]['key'];

export function DemoRolePicker(): ReactElement | null {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { login } = useAuth();
  const { push } = useRouter();
  const [pending, setPending] = useState<ProfileKey | null>(null);
  const [failed, setFailed] = useState(false);
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return null;

  async function signIn(key: ProfileKey, email: string): Promise<void> {
    setPending(key);
    setFailed(false);
    try {
      await login({ email, password: 'demo' });
      push('/dashboard');
    } catch {
      setFailed(true);
      setPending(null);
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
      <ul className="flex flex-col gap-3">
        {DEMO_PROFILES.map(({ key, name, email, Icon }) => {
          const role = t(key === 'admin' ? 'demo.picker.admin' : 'demo.picker.coach');
          return (
            <li key={key}>
              <button
                type="button"
                disabled={pending !== null}
                aria-label={t('demo.picker.signInAs', { name, role })}
                onClick={() => {
                  void signIn(key, email);
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">
                    {name} · {role}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(key === 'admin' ? 'demo.picker.adminHint' : 'demo.picker.coachHint')}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('demo.picker.error')}
        </p>
      ) : null}
    </section>
  );
}
