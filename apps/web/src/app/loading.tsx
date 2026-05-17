import type { ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

export default function RootLoading(): ReactElement {
  return (
    <main
      id="main-content"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12"
    >
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-5 w-80 max-w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>
    </main>
  );
}
