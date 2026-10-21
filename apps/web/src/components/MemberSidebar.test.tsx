import { describe, expect, it } from 'vitest';

import { SETTINGS_PATHS } from '../app/me/settings/routes';
import { createTranslator } from '../lib/i18n/t';

import { memberSections } from './MemberSidebar';

import type { SidebarGroup, SidebarLink } from './sidebar/nav-model';

const t = createTranslator('fr');

describe('memberSections', () => {
  it('opens the main section on the member home, matched exactly', () => {
    const [main] = memberSections(t, false);
    const home = main?.items[0] as SidebarLink;
    expect(home).toMatchObject({ href: '/me', match: 'exact', label: t('web.nav.home') });
  });

  it('lists every settings section, in order, under the account group', () => {
    const account = memberSections(t, false)[1]?.items[0] as SidebarGroup;
    expect(account.label).toBe(t('web.home.me'));
    expect(account.children.map((link) => link.href)).toEqual([
      SETTINGS_PATHS.profile,
      SETTINGS_PATHS.security,
      SETTINGS_PATHS.notifications,
      SETTINGS_PATHS.preferences,
      SETTINGS_PATHS.health,
      SETTINGS_PATHS.privacy,
    ]);
    expect(account.children.map((link) => link.label)).toEqual([
      'Profil',
      'Sécurité',
      'Notifications',
      'Préférences',
      'Santé et appareils',
      'Confidentialité',
    ]);
  });

  it('adds the coach only when the flag is on', () => {
    const hrefs = (on: boolean): string[] =>
      (memberSections(t, on)[0]?.items ?? []).map((item) => (item as SidebarLink).href);
    expect(hrefs(false)).not.toContain('/me/coach');
    expect(hrefs(true)).toContain('/me/coach');
  });
});
