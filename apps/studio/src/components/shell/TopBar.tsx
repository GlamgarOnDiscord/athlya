'use client';

import { CaretRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';

import { Skeleton } from '@/components/ui/skeleton';

import { ThemeToggle } from './ThemeToggle';
import { useShortcutLabel } from './use-shortcut-label';

import type { Translator } from '../../lib/i18n/t';
import type { ReactElement } from 'react';

interface TopBarProps {
  readonly studioName: string | null;
  readonly pageLabel: string | null;
  readonly onSearch: () => void;
  readonly t: Translator;
}

/** Desktop bar above every console page: breadcrumb, search and theme. */
export function TopBar({ studioName, pageLabel, onSearch, t }: TopBarProps): ReactElement {
  return (
    <div className="sticky top-0 z-30 hidden h-14 items-center gap-4 border-b border-border bg-background px-8 lg:flex">
      <nav aria-label={t('studio.shell.breadcrumb')} className="min-w-0 flex-1">
        <ol className="flex items-center gap-2 text-sm">
          <li className="truncate text-muted-foreground">
            {studioName ?? <Skeleton className="h-4 w-28" />}
          </li>
          {pageLabel === null ? null : (
            <>
              <li aria-hidden="true">
                <CaretRightIcon className="size-3.5 text-muted-foreground" />
              </li>
              <li aria-current="page" className="truncate font-medium">
                {pageLabel}
              </li>
            </>
          )}
        </ol>
      </nav>
      <SearchButton onSearch={onSearch} t={t} />
      <ThemeToggle t={t} />
    </div>
  );
}

/** Opens the command palette; styled as a field, shows its shortcut. */
export function SearchButton({
  onSearch,
  t,
  className,
}: {
  readonly onSearch: () => void;
  readonly t: Translator;
  readonly className?: string;
}): ReactElement {
  const shortcut = useShortcutLabel('K');
  return (
    <button
      type="button"
      onClick={onSearch}
      aria-keyshortcuts="Control+K Meta+K"
      className={
        className ??
        'flex h-8 w-56 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      }
    >
      <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="flex-1 truncate text-left">{t('studio.shell.search')}</span>
      <kbd className="rounded border border-border px-1 font-sans text-[0.6875rem]">{shortcut}</kbd>
    </button>
  );
}
