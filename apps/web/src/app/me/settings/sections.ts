import {
  BellIcon,
  HeartbeatIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserIcon,
} from '@phosphor-icons/react';

import { SETTINGS_PATHS } from './routes';

import type { TranslationKeys } from '@athlya/shared/i18n';
import type { Icon } from '@phosphor-icons/react';

export interface SettingsSection {
  readonly id: keyof typeof SETTINGS_PATHS;
  readonly href: string;
  readonly labelKey: TranslationKeys;
  readonly icon: Icon;
}

/** Settings sections with their sidebar icons, in the order the sidebar lists them. */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: 'profile',
    href: SETTINGS_PATHS.profile,
    labelKey: 'web.settings.sections.profile',
    icon: UserIcon,
  },
  {
    id: 'security',
    href: SETTINGS_PATHS.security,
    labelKey: 'web.settings.sections.security',
    icon: ShieldCheckIcon,
  },
  {
    id: 'notifications',
    href: SETTINGS_PATHS.notifications,
    labelKey: 'web.settings.sections.notifications',
    icon: BellIcon,
  },
  {
    id: 'preferences',
    href: SETTINGS_PATHS.preferences,
    labelKey: 'web.settings.sections.preferences',
    icon: SlidersHorizontalIcon,
  },
  {
    id: 'health',
    href: SETTINGS_PATHS.health,
    labelKey: 'web.settings.sections.health',
    icon: HeartbeatIcon,
  },
  {
    id: 'privacy',
    href: SETTINGS_PATHS.privacy,
    labelKey: 'web.settings.sections.privacy',
    icon: LockKeyIcon,
  },
];
