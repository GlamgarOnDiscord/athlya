import { Skeleton } from '@/components/ui/skeleton';

import type { ReactElement } from 'react';

export default function RootLoading(): ReactElement {
    return (
        <main
            id="main-content"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="Chargement"
            className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 p-6"
        >
            <div className="flex items-center gap-4 border-b border-border pb-4">
                <Skeleton className="h-6 w-32" />
                <div className="ml-auto flex gap-4">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-16" />
                </div>
            </div>
            <div className="flex flex-col gap-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-96 max-w-full" />
                <div className="grid gap-4 sm:grid-cols-2">
                    <Skeleton className="h-32 rounded-lg" />
                    <Skeleton className="h-32 rounded-lg" />
                </div>
            </div>
        </main>
    );
}
