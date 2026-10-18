/**
 * `<CoachPanel />` — AI coach (Epic 21, web).
 *
 * Reads `GET /v1/coach` first: the panel only offers the coach when the
 * `ai-coach` feature flag is on for the member, and only shows the
 * question form once the `thirdParty` consent is granted (otherwise it
 * links to the consents form on `/me`).
 *
 * `POST /v1/coach/ask` answers in one validated JSON payload. The
 * "preparing" message and the answer are rendered inside one polite
 * `aria-live` region (`aria-busy` while the request runs), so screen
 * readers announce the advice once it is complete. Errors use
 * `role="alert"`.
 *
 * Optional `client` and `t` props are test seams, as in
 * `<ProgressionPanel />`.
 */
'use client';

import {
  COACH_QUESTION_MAX_LENGTH,
  CoachAskResponseSchema,
  CoachStatusResponseSchema,
  type CoachAskResponse,
  type CoachQuota,
} from '@athlya/shared/schemas/api';
import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

import { ApiError } from '../../../lib/api/client';
import { useApiClient } from '../../../lib/api/use-api-client';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../../lib/i18n/t';

import type { ApiClient } from '../../../lib/api/client';

export interface CoachPanelProps {
  readonly t?: Translator;
  readonly client?: ApiClient;
}

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'ready'; readonly consent: boolean; readonly quota: CoachQuota };

type AskState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly answer: CoachAskResponse }
  | { readonly kind: 'error'; readonly message: string };

const QUESTION_ID = 'coach-question';
const HINT_ID = 'coach-question-hint';
const COUNTER_ID = 'coach-question-counter';

export function CoachPanel({ t: tProp, client: clientProp }: CoachPanelProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);
  const client = useApiClient(clientProp);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<AskState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    client
      .get<unknown>('/v1/coach')
      .then((raw) => {
        if (cancelled) return;
        const parsed = CoachStatusResponseSchema.safeParse(raw);
        if (!parsed.success) {
          setStatus({ kind: 'error' });
        } else if (!parsed.data.enabled) {
          setStatus({ kind: 'disabled' });
        } else {
          setStatus({
            kind: 'ready',
            consent: parsed.data.thirdPartyConsent,
            quota: parsed.data.quota,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

  const trimmed = question.trim();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (status.kind !== 'ready' || trimmed.length === 0) return;
    setAsk({ kind: 'pending' });
    try {
      const raw = await client.post<unknown>('/v1/coach/ask', {
        question: trimmed,
        locale: locale === 'en' ? 'en' : 'fr',
      });
      const parsed = CoachAskResponseSchema.safeParse(raw);
      if (!parsed.success) {
        setAsk({ kind: 'error', message: t('coach.errors.unavailable') });
        return;
      }
      setStatus({ ...status, quota: parsed.data.quota });
      setAsk({ kind: 'done', answer: parsed.data });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        if (err.problem?.code === 'coach_quota_exceeded') {
          setStatus({ ...status, quota: { ...status.quota, remaining: 0 } });
          setAsk({ kind: 'error', message: t('coach.quotaExhausted') });
        } else {
          setAsk({ kind: 'error', message: t('coach.errors.rateLimited') });
        }
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setStatus({ ...status, consent: false });
        setAsk({ kind: 'idle' });
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setStatus({ kind: 'disabled' });
        return;
      }
      setAsk({ kind: 'error', message: t('coach.errors.unavailable') });
    }
  }

  if (status.kind === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {t('common.loading')}
      </p>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="flex flex-col gap-2" role="alert">
        <p className="text-sm text-destructive">{t('errors.generic')}</p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setStatus({ kind: 'loading' });
            setReloadNonce((n) => n + 1);
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (status.kind === 'disabled') {
    return <p className="text-sm text-muted-foreground">{t('coach.disabled')}</p>;
  }

  const { quota, consent } = status;
  const exhausted = quota.remaining === 0;
  const pending = ask.kind === 'pending';
  const answer = ask.kind === 'done' ? ask.answer.advice : null;

  return (
    <section aria-labelledby="coach-heading" className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t('coach.description')}</p>
      <p className="text-sm text-muted-foreground">{t('coach.privacy')}</p>

      {consent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Label htmlFor={QUESTION_ID}>{t('coach.question.label')}</Label>
          <textarea
            id={QUESTION_ID}
            name="question"
            rows={4}
            required
            maxLength={COACH_QUESTION_MAX_LENGTH}
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            aria-describedby={`${HINT_ID} ${COUNTER_ID}`}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          />
          <p id={HINT_ID} className="text-xs text-muted-foreground">
            {t('coach.question.hint', { max: COACH_QUESTION_MAX_LENGTH })}
          </p>
          <p id={COUNTER_ID} className="text-xs text-muted-foreground">
            {t('coach.question.counter', {
              count: question.length,
              max: COACH_QUESTION_MAX_LENGTH,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || exhausted || trimmed.length === 0}>
              {t('coach.submit')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {exhausted
                ? t('coach.quotaExhausted')
                : t('coach.quota', { remaining: quota.remaining, limit: quota.limit })}
            </p>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{t('coach.consentRequired')}</p>
          <Link
            href="/me#consents-heading"
            className="self-start text-sm font-medium underline underline-offset-4"
          >
            {t('coach.consentLink')}
          </Link>
        </div>
      )}

      {ask.kind === 'error' ? (
        <p className="text-sm text-destructive" role="alert">
          {ask.message}
        </p>
      ) : null}

      <div aria-live="polite" aria-busy={pending} className="flex flex-col gap-4">
        {pending ? <p className="text-sm text-muted-foreground">{t('coach.thinking')}</p> : null}
        {answer !== null ? (
          <article aria-labelledby="coach-answer-heading" className="flex flex-col gap-4">
            <h2 id="coach-answer-heading" className="text-xl font-semibold">
              {t('coach.answer.title')}
            </h2>
            <p>{answer.summary}</p>
            <h3 className="text-base font-semibold">{t('coach.answer.recommendations')}</h3>
            <ol className="flex list-decimal flex-col gap-3 pl-5">
              {answer.recommendations.map((rec, index) => (
                <li key={`${String(index)}-${rec.title}`}>
                  <p className="font-medium">{rec.title}</p>
                  <p className="text-sm text-muted-foreground">{rec.detail}</p>
                </li>
              ))}
            </ol>
            {answer.caution !== null ? (
              <div role="note" className="rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{t('coach.answer.caution')}</p>
                <p className="text-sm">{answer.caution}</p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('coach.answer.disclaimer')}</p>
          </article>
        ) : null}
      </div>
    </section>
  );
}
