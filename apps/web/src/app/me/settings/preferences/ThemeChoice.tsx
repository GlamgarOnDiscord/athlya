'use client';

import { DesktopIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { selectedTheme, THEME_LABEL_KEYS, THEME_VALUES, type ThemeValue } from './theme-options';

import type { Translator } from '../../../../lib/i18n/t';
import type { Icon } from '@phosphor-icons/react';

const ICONS: Readonly<Record<ThemeValue, Icon>> = {
  light: SunIcon,
  dark: MoonIcon,
  system: DesktopIcon,
};

const noop = (): (() => void) => () => undefined;

/**
 * Light, dark or system theme as a native radio group, so arrow keys move
 * between options. Nothing is checked until the stored theme is read on
 * the client, so the server render never claims a choice.
 */
export function ThemeChoice({ t }: { readonly t: Translator }): ReactElement {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const current = mounted ? selectedTheme(theme) : null;

  return (
    <fieldset className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
      <legend className="sr-only">{t('web.settings.preferences.theme.title')}</legend>
      {THEME_VALUES.map((value) => {
        const OptionIcon = ICONS[value];
        return (
          <label
            key={value}
            className={cn(
              'flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              current === value && 'bg-muted text-foreground',
            )}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={current === value}
              onChange={() => setTheme(value)}
              className="sr-only"
            />
            <OptionIcon aria-hidden="true" className="size-4" />
            {t(THEME_LABEL_KEYS[value])}
          </label>
        );
      })}
    </fieldset>
  );
}
