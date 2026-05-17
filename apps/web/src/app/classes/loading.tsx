/**
 * Route-level loading skeleton for `/classes`.
 *
 * Suspense fallbacks must be synchronous — no async, no headers().
 * Mirrors the final page shape so the viewport doesn't shift when
 * real data arrives.
 */

import type { ReactElement } from 'react';

export default function ClassesLoading(): ReactElement {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12"
    >
      <div className="h-9 w-48 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
      <ul className="flex flex-col gap-3">
        {(['s1', 's2', 's3'] as const).map((id) => (
          <li
            key={id}
            aria-hidden="true"
            className="h-28 animate-pulse rounded-lg border border-border bg-muted"
          />
        ))}
      </ul>
    </main>
  );
}
