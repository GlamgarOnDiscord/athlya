'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { useShortcutLabel } from './use-shortcut-label';

import type { Translator } from '../../lib/i18n/t';
import type { ReactElement } from 'react';

interface ShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly t: Translator;
}

/** "Aide": the keyboard shortcuts the console answers to. */
export function ShortcutsDialog({ open, onOpenChange, t }: ShortcutsDialogProps): ReactElement {
  const paletteKeys = useShortcutLabel('K');
  const rows = [
    { keys: paletteKeys, label: t('studio.shell.shortcuts.palette') },
    { keys: '/', label: t('studio.shell.shortcuts.memberSearch') },
    { keys: '?', label: t('studio.shell.shortcuts.help') },
    { keys: t('studio.shell.shortcuts.escapeKey'), label: t('studio.shell.shortcuts.close') },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('studio.shell.shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <dl className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-sm">{row.label}</dt>
              <dd>
                <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-xs">
                  {row.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
