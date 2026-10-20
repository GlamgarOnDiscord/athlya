import type { ReactElement, ReactNode } from 'react';

interface PageHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}

/** Page title and lead on the left, page actions on the right (stacked on phones). */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps): ReactElement {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle === undefined ? null : (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
