/**
 * Member consents form — `PATCH /v1/members/me/consents`.
 *
 * The read-only `version` + `updatedAt` appear in a `<dl>` at the
 * top of the section because they're metadata the server owns — the
 * client only ever submits the three boolean flags (Req 3.3), and
 * the gateway stamps `version` + `updatedAt` on write.
 *
 * Submit path mirrors `ProfileForm.tsx`:
 *   - `PATCH` with a fresh `Idempotency-Key`.
 *   - Success banner dismisses after 3 s.
 *   - 422 `validation_error` maps `problem.errors[]` to per-flag
 *     `role="alert"` regions; other failures surface a generic error.
 *
 * @see Requirements 3.1, 3.3.
 */
'use client';

import { UpdateConsentsRequestSchema } from '@athlya/shared/schemas/api';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

import { ApiError, type ApiClient } from '../../lib/api/client';
import { newIdempotencyKey } from '../../lib/idempotency';
import { useLocale } from '../../lib/i18n/LocaleContext';

import type { Translator } from '../../lib/i18n/t';
import type { Consents } from '@athlya/shared/schemas';

export interface ConsentsFormProps {
  readonly consents: Consents;
  readonly client: ApiClient;
  readonly t: Translator;
}

const SUCCESS_BANNER_MS = 3_000;

export function ConsentsForm({ consents, client, t }: ConsentsFormProps): ReactElement {
  const locale = useLocale();

  interface ConsentsFormState {
    marketing: boolean;
    analytics: boolean;
    thirdParty: boolean;
    fieldErrors: Record<string, string>;
    genericError: string | null;
    pending: boolean;
    submittedAt: number | null;
  }

  const [form, setForm] = useState<ConsentsFormState>(() => ({
    marketing: consents.marketing,
    analytics: consents.analytics,
    thirdParty: consents.thirdParty,
    fieldErrors: {},
    genericError: null,
    pending: false,
    submittedAt: null,
  }));

  useEffect(() => {
    if (form.submittedAt === null) return undefined;
    const timer = setTimeout(() => {
      setForm((s) => ({ ...s, submittedAt: null }));
    }, SUCCESS_BANNER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [form.submittedAt]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setForm((s) => ({ ...s, fieldErrors: {}, genericError: null }));

      const payload = {
        marketing: form.marketing,
        analytics: form.analytics,
        thirdParty: form.thirdParty,
      };
      const parsed = UpdateConsentsRequestSchema.safeParse(payload);
      if (!parsed.success) {
        const next = Object.create(null) as Record<string, string>;
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (next[path] === undefined) next[path] = issue.message;
        }
        setForm((s) => ({ ...s, fieldErrors: next }));
        return;
      }

      setForm((s) => ({ ...s, pending: true }));
      try {
        await client.patch('/v1/members/me/consents', parsed.data, {
          headers: { 'Idempotency-Key': newIdempotencyKey() },
        });
        setForm((s) => ({ ...s, submittedAt: Date.now() }));
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.problem?.code === 'validation_error' &&
          err.problem.errors !== undefined
        ) {
          const next = Object.create(null) as Record<string, string>;
          for (const e of err.problem.errors) {
            if (next[e.path] === undefined) next[e.path] = e.message;
          }
          setForm((s) => ({ ...s, fieldErrors: next }));
        } else {
          setForm((s) => ({ ...s, genericError: t('errors.generic') }));
        }
      } finally {
        setForm((s) => ({ ...s, pending: false }));
      }
    },
    [form, client, t],
  );

  const formattedUpdatedAt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(consents.updatedAt)),
    [locale, consents.updatedAt],
  );

  return (
    <section aria-labelledby="consents-heading" className="flex flex-col gap-4">
      <h2 id="consents-heading" className="text-xl font-semibold">
        {t('consents.title')}
      </h2>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">{t('consents.version')}</dt>
        <dd>{consents.version}</dd>
        <dt className="font-medium">{t('consents.updatedAt')}</dt>
        <dd>{formattedUpdatedAt}</dd>
      </dl>

      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        noValidate
        className="flex flex-col gap-3"
      >
        <label htmlFor="consents-marketing" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="consents-marketing"
            checked={form.marketing}
            onCheckedChange={(checked) => setForm((s) => ({ ...s, marketing: checked === true }))}
            aria-describedby="consents-marketing-error"
          />
          <span>{t('consents.marketing')}</span>
        </label>
        {form.fieldErrors['marketing'] !== undefined ? (
          <span
            id="consents-marketing-error"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {form.fieldErrors['marketing']}
          </span>
        ) : null}

        <label htmlFor="consents-analytics" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="consents-analytics"
            checked={form.analytics}
            onCheckedChange={(checked) => setForm((s) => ({ ...s, analytics: checked === true }))}
            aria-describedby="consents-analytics-error"
          />
          <span>{t('consents.analytics')}</span>
        </label>
        {form.fieldErrors['analytics'] !== undefined ? (
          <span
            id="consents-analytics-error"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {form.fieldErrors['analytics']}
          </span>
        ) : null}

        <label htmlFor="consents-third-party" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="consents-third-party"
            checked={form.thirdParty}
            onCheckedChange={(checked) => setForm((s) => ({ ...s, thirdParty: checked === true }))}
            aria-describedby="consents-third-party-error"
          />
          <span>{t('consents.thirdParty')}</span>
        </label>
        {form.fieldErrors['thirdParty'] !== undefined ? (
          <span
            id="consents-third-party-error"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {form.fieldErrors['thirdParty']}
          </span>
        ) : null}

        {form.genericError !== null ? (
          <span role="alert" aria-live="polite" className="text-sm text-destructive">
            {form.genericError}
          </span>
        ) : null}

        {form.submittedAt !== null ? (
          <span
            role="status"
            aria-live="polite"
            className="text-sm text-emerald-600 dark:text-emerald-400"
          >
            {t('consents.updateSuccess')}
          </span>
        ) : null}

        <Button type="submit" disabled={form.pending} className="self-start">
          {t('consents.save')}
        </Button>
      </form>
    </section>
  );
}
