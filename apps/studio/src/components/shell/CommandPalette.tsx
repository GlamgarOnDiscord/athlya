'use client';

/**
 * Console command palette (Cmd+K or Ctrl+K): jump to a page, a class or a
 * member. Pages come from the navigation; classes of the next 30 days and
 * the member directory load once, the first time the palette opens, and
 * are filtered on the client.
 */
import {
  CalendarBlankIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  UserIcon,
} from '@phosphor-icons/react';
import { addDays, startOfDay } from 'date-fns';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { useApiClient } from '../../lib/api/buildClient';
import { fetchMemberDirectory } from '../../lib/api/members';
import { useAuth } from '../../lib/auth/AuthContext';
import { navigateTo } from '../../lib/full-reload';

import { searchCommands, type CommandItem, type CommandKind } from './command-search';

import type { Translator } from '../../lib/i18n/t';
import type { Locale } from '@athlya/shared/i18n';

const CLASS_DAYS = 30;

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pages: ReadonlyArray<CommandItem>;
  /** Where a class hit leads: the admin classes page, or a coach's schedule. */
  readonly classesHref: string;
  readonly locale: Locale;
  readonly t: Translator;
}

const KIND_ICON = {
  page: SquaresFourIcon,
  class: CalendarBlankIcon,
  member: UserIcon,
} as const;

export function CommandPalette({
  open,
  onOpenChange,
  pages,
  classesHref,
  locale,
  t,
}: CommandPaletteProps): ReactElement {
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState<ReadonlyArray<CommandItem> | null>(null);
  const [requested, setRequested] = useState(false);

  if (open && !requested) setRequested(true);

  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    const from = startOfDay(new Date());
    const range = new URLSearchParams({
      from: from.toISOString(),
      to: addDays(from, CLASS_DAYS).toISOString(),
    });
    const when = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    void Promise.allSettled([
      client.get<{ items: ReadonlyArray<{ id: string; title: string; startsAt: string }> }>(
        `/v1/classes?${range.toString()}`,
      ),
      fetchMemberDirectory(client),
    ]).then(([classes, members]) => {
      if (cancelled) return;
      const items: CommandItem[] = [];
      if (classes.status === 'fulfilled') {
        for (const c of classes.value.items) {
          items.push({
            id: `class-${c.id}`,
            kind: 'class',
            label: c.title,
            hint: when.format(new Date(c.startsAt)),
            href: classesHref,
          });
        }
      }
      if (members.status === 'fulfilled') {
        for (const m of members.value.items) {
          items.push({
            id: `member-${m.id}`,
            kind: 'member',
            label: m.displayName,
            hint: m.email,
            href: `/dashboard/members?q=${encodeURIComponent(m.email)}`,
          });
        }
      }
      setLoaded(items);
    });
    return () => {
      cancelled = true;
    };
  }, [client, classesHref, locale, requested]);

  const results = useMemo(
    () => searchCommands([...pages, ...(loaded ?? [])], query),
    [pages, loaded, query],
  );
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setActive(0);
    }
  };

  const go = (item: CommandItem | undefined): void => {
    if (item === undefined) return;
    close(false);
    navigateTo(item.href, router.push, pathname);
  };

  const groupLabel: Record<CommandKind, string> = {
    page: t('studio.shell.palette.pages'),
    class: t('studio.shell.palette.classes'),
    member: t('studio.shell.palette.members'),
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} className="top-24 translate-y-0 gap-0 p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{t('studio.shell.palette.title')}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <MagnifyingGlassIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              results[activeIndex] === undefined ? undefined : `${listId}-${String(activeIndex)}`
            }
            aria-label={t('studio.shell.search')}
            placeholder={t('studio.shell.palette.placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(results[activeIndex]);
              }
            }}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul id={listId} role="listbox" className="max-h-80 overflow-y-auto p-2">
          {results.map((item, index) => {
            const Icon = KIND_ICON[item.kind];
            const first = index === 0 || results[index - 1]?.kind !== item.kind;
            return (
              <li key={item.id} role="presentation">
                {first ? (
                  <p
                    aria-hidden="true"
                    className="px-2 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {groupLabel[item.kind]}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${String(index)}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onPointerMove={() => setActive(index)}
                  onClick={() => go(item)}
                  className={cn(
                    'flex cursor-default items-center gap-3 rounded-md px-2 py-2 text-sm',
                    index === activeIndex && 'bg-muted',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{item.label}</span>
                  {item.hint === '' ? null : (
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {item.hint}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {results.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            {loaded === null ? t('studio.shell.palette.loading') : t('studio.shell.palette.empty')}
          </p>
        ) : null}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {t('studio.shell.palette.hint')}
        </p>
      </DialogContent>
    </Dialog>
  );
}
