/**
 * `<ExportPanel />` — RGPD export request.
 *
 * The member clicks "Export my data" and we `POST /v1/members/me/export`
 * with a fresh `Idempotency-Key`. The backend enqueues an async job
 * and returns `202 Accepted` with `{ jobId }`. We surface a pending
 * banner with the job reference; the user is notified by email once
 * the archive is ready (design: 48 h SLA).
 *
 * Layering mirrors `<ProfileSection />`:
 *   - Optional `client` prop injects an {@link ApiClient} for tests,
 *     real callers get one via {@link createApiClient}.
 *   - Optional `t` prop for tests; omitted in production (derived
 *     from the surrounding `<LocaleProvider>` via {@link useLocale}).
 *
 * @see Requirements 4.1, 5.1.
 */
'use client';

import {
    useCallback,
    useMemo,
    useState,
    type ReactElement,
} from 'react';

import { Button } from '@/components/ui/button';

import { type ApiClient } from '../../../lib/api/client';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';
import { newIdempotencyKey } from '../../../lib/idempotency';

export interface ExportPanelProps {
    /** Optional translator — derived from `useLocale()` when absent. */
    readonly t?: Translator;
    /** Test seam: inject a fake API client instead of the real one. */
    readonly client?: ApiClient;
}

/** Gateway response on 202 Accepted. */
interface ExportJobResponse {
    readonly jobId: string;
}

type Status = 'idle' | 'pending' | 'requested' | 'error';

export function ExportPanel({
    t: tProp,
    client: clientProp,
}: ExportPanelProps): ReactElement {
    const locale = useLocale();
    const t: Translator = useMemo(
        () => tProp ?? createTranslator(locale),
        [tProp, locale],
    );

    const client = useApiClient(clientProp);

    const [status, setStatus] = useState<Status>('idle');
    const [jobId, setJobId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const onRequest = useCallback(async () => {
        setStatus('pending');
        setErrorMsg(null);
        try {
            const response = await client.post<ExportJobResponse>(
                '/v1/members/me/export',
                {},
                { headers: { 'Idempotency-Key': newIdempotencyKey() } },
            );
            setJobId(response.jobId);
            setStatus('requested');
        } catch {
            setErrorMsg(t('errors.generic'));
            setStatus('error');
        }
    }, [client, t]);

    const isPending = status === 'pending';
    const isRequested = status === 'requested';
    const isError = status === 'error';

    return (
        <section aria-label={t('rgpd.export.title')} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
                {t('rgpd.export.description')}
            </p>

            <Button
                onClick={() => { void onRequest(); }}
                disabled={isPending}
                className="self-start"
            >
                {isPending ? t('common.loading') : t('rgpd.export.request')}
            </Button>

            {isRequested && jobId !== null ? (
                <div className="flex flex-col gap-2">
                    <span
                        role="status"
                        aria-live="polite"
                        className="text-sm text-emerald-600 dark:text-emerald-400"
                    >
                        {t('rgpd.export.pending')}
                    </span>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                        <dt className="font-medium">{t('rgpd.export.jobId')}</dt>
                        <dd>{jobId}</dd>
                    </dl>
                </div>
            ) : null}

            {isError && errorMsg !== null ? (
                <span role="alert" aria-live="polite" className="text-sm text-destructive">
                    {errorMsg}
                </span>
            ) : null}
        </section>
    );
}
