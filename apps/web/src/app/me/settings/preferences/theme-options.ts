import type { TranslationKeys } from '@athlya/shared/i18n';

export const THEME_VALUES = ['light', 'dark', 'system'] as const;

export type ThemeValue = (typeof THEME_VALUES)[number];

export const THEME_LABEL_KEYS: Readonly<Record<ThemeValue, TranslationKeys>> = {
  light: 'web.settings.preferences.theme.light',
  dark: 'web.settings.preferences.theme.dark',
  system: 'web.settings.preferences.theme.system',
};

/**
 * The option to show as selected. next-themes reports `undefined` until
 * it reads the stored choice on the client, and the stored value may be
 * anything a former build wrote: neither selects an option.
 */
export function selectedTheme(theme: string | undefined): ThemeValue | null {
  return THEME_VALUES.find((value) => value === theme) ?? null;
}
