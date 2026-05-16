/**
 * Route-level loading skeleton for `/me`.
 *
 * Suspense fallbacks must be synchronous — no async, no headers().
 * Two skeleton blocks keep the viewport anchored while data resolves.
 */

import type { ReactElement } from 'react';

export default function MeLoading(): ReactElement {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12"
    >
      <div className="h-9 w-48 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
      <div
        aria-hidden="true"
        className="h-32 animate-pulse rounded-lg border border-border bg-muted"
      />
      <div
        aria-hidden="true"
        className="h-24 animate-pulse rounded-lg border border-border bg-muted"
      />
    </main>
  );
}
