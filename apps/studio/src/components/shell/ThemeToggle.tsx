'use client';

import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import type { Translator } from '../../lib/i18n/t';

const noop = (): (() => void) => () => undefined;

/** Light and dark switch; neither is pressed until the theme resolves on the client. */
export function ThemeToggle({ t }: { readonly t: Translator }): ReactElement {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const current = mounted ? resolvedTheme : undefined;

  const options = [
    { value: 'light', label: t('studio.shell.theme.light'), Icon: SunIcon },
    { value: 'dark', label: t('studio.shell.theme.dark'), Icon: MoonIcon },
  ] as const;

  return (
    <div
      role="group"
      aria-label={t('studio.shell.theme.label')}
      className="inline-flex h-8 items-center rounded-lg border border-border bg-background p-0.5"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={current === value}
          onClick={() => setTheme(value)}
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            current === value && 'bg-muted text-foreground',
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      ))}
    </div>
  );
}
