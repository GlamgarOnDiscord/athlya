/**
 * Layout pieces shared by the settings sections. No hooks, so server
 * and client components both render them.
 */
import { cn } from '@/lib/utils';

import type { ReactElement, ReactNode } from 'react';

export function SettingsHeader({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReactElement {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

/** A bordered list of rows; `label` names the list for assistive technology. */
export function SettingsList({
  label,
  children,
}: {
  readonly label?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ul
      aria-label={label}
      className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card"
    >
      {children}
    </ul>
  );
}

export interface SettingsRowProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Label of a feature the roadmap promises but the API does not serve yet. */
  readonly comingSoon?: string;
  /** Control or status on the trailing side (below the text on phones). */
  readonly children?: ReactNode;
}

export function SettingsRow({
  title,
  description,
  comingSoon,
  children,
}: SettingsRowProps): ReactElement {
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className={cn(
            'flex flex-wrap items-center gap-2 text-sm font-medium',
            comingSoon !== undefined && 'text-muted-foreground',
          )}
        >
          {title}
          {comingSoon !== undefined ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {comingSoon}
            </span>
          ) : null}
        </p>
        {description !== undefined ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {children !== undefined ? <div className="shrink-0">{children}</div> : null}
    </li>
  );
}
