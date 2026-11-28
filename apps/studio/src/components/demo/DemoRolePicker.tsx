/**
 * One-click sign-in of a demo build (issue #750), shown on `/login` in
 * place of the credentials form: no password, no Turnstile, no refresh
 * cookie. The login goes through `useAuth().login`, which the demo
 * transport answers from the fake API. One profile per staff role; the
 * member profile lives in the member app, since a member cannot use the
 * console.
 */
'use client';

import {
  BriefcaseIcon,
  ChalkboardTeacherIcon,
  IdentificationBadgeIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactElement } from 'react';

import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import type { TranslationKeys } from '@athlya/shared/i18n';
import type { StaffRole } from '@athlya/shared/roles';
import type { Icon } from '@phosphor-icons/react';

interface DemoProfile {
  readonly key: StaffRole;
  readonly name: string;
  readonly email: string;
  readonly Icon: Icon;
  readonly label: TranslationKeys;
  readonly hint: TranslationKeys;
}

const DEMO_PROFILES: readonly DemoProfile[] = [
  {
    key: 'admin',
    name: 'Camille Durand',
    email: 'camille.durand@example.com',
    Icon: ShieldCheckIcon,
    label: 'demo.picker.admin',
    hint: 'demo.picker.adminHint',
  },
  {
    key: 'manager',
    name: 'Hugo Lefebvre',
    email: 'hugo.lefebvre@example.com',
    Icon: BriefcaseIcon,
    label: 'studio.members.role.manager',
    hint: 'demo.picker.managerHint',
  },
  {
    key: 'accueil',
    name: 'Sarah Benali',
    email: 'sarah.benali@example.com',
    Icon: IdentificationBadgeIcon,
    label: 'studio.members.role.accueil',
    hint: 'demo.picker.accueilHint',
  },
  {
    key: 'coach',
    name: 'Inès Garnier',
    email: 'ines.garnier@example.com',
    Icon: ChalkboardTeacherIcon,
    label: 'demo.picker.coach',
    hint: 'demo.picker.coachHint',
  },
];

export function DemoRolePicker(): ReactElement | null {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { login } = useAuth();
  const { push } = useRouter();
  const [pending, setPending] = useState<StaffRole | null>(null);
  const [failed, setFailed] = useState(false);
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return null;

  async function signIn(key: StaffRole, email: string): Promise<void> {
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
        {DEMO_PROFILES.map(({ key, name, email, Icon: ProfileIcon, label, hint }) => {
          const role = t(label);
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
                  <ProfileIcon size={20} aria-hidden="true" />
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">
                    {name} · {role}
                  </span>
                  <span className="text-xs text-muted-foreground">{t(hint)}</span>
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
