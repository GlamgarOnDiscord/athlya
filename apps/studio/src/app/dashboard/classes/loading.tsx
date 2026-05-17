/**
 * Suspense fallback for `/dashboard/classes`.
 *
 * Must be synchronous — no async, no headers().
 */

import type { ReactElement } from 'react';

export default function ClassesLoading(): ReactElement {
  return (
    <section
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4"
    >
      <span
        aria-hidden="true"
        className="size-10 animate-spin rounded-full border-2 border-border border-t-brand-primary"
      />
    </section>
  );
}
