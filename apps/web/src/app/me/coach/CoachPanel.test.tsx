/**
 * Component tests for `<CoachPanel />` and `<CoachLink />` (Epic 21, web).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiServerError, createApiClient } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { CoachLink } from './CoachLink';
import { CoachPanel } from './CoachPanel';

import type { ApiClient } from '../../../lib/api/client';
import type { CoachAskResponse, CoachStatusResponse } from '@athlya/shared/schemas/api';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('en');

const QUOTA = { limit: 10, remaining: 4, resetsAt: '2026-10-16T00:00:00.000Z' };
const ENABLED: CoachStatusResponse = { enabled: true, thirdPartyConsent: true, quota: QUOTA };

const ANSWER: CoachAskResponse = {
  advice: {
    summary: 'Your squat volume is steady.',
    recommendations: [
      { title: 'Add a back-off set', detail: 'One set at 80 % after the top set.' },
      { title: 'Sleep more', detail: 'Aim for eight hours before heavy days.' },
    ],
    caution: 'See a physiotherapist about the knee pain.',
  },
  quota: { ...QUOTA, remaining: 3 },
  generatedAt: '2026-10-15T14:30:00.000Z',
};

const UPSTREAM_FAILED = {
  type: 'about:blank',
  title: 'Bad Gateway',
  status: 502,
  code: 'coach_upstream_failed',
};

type PostStream = ApiClient['postStream'];

function fakeClient(
  get: ApiClient['get'],
  postStream: PostStream = vi.fn<PostStream>(),
): ApiClient {
  return { get, postStream, post: vi.fn(), patch: vi.fn(), del: vi.fn() } as unknown as ApiClient;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An event-stream response whose events the test writes one by one. */
function eventStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    async send(event: string, data: unknown): Promise<void> {
      controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      await settle();
    },
    async close(): Promise<void> {
      controller?.close();
      await settle();
    },
  };
}

/** Lets the stream reads and the state updates they trigger run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function signalOf(postStream: ReturnType<typeof vi.fn<PostStream>>, call = 0): AbortSignal {
  const init = postStream.mock.calls[call]?.[2];
  if (init?.signal === undefined || init.signal === null) throw new Error('no signal');
  return init.signal;
}

function wrap(children: ReactNode): ReactElement {
  return <LocaleProvider locale="en">{children}</LocaleProvider>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function typeQuestion(value: string): void {
  fireEvent.change(screen.getByLabelText(t('coach.question.label')), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: t('coach.submit') }));
}

afterEach(() => {
  cleanup();
});

describe('<CoachPanel />', () => {
  it('says the coach is unavailable when the flag is off', async () => {
    const get = vi.fn().mockResolvedValue({ enabled: false });
    render(wrap(<CoachPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(get).toHaveBeenCalledWith('/v1/coach');
    expect(screen.getByText(t('coach.disabled'))).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('asks for the third-party consent before showing the form', async () => {
    const get = vi.fn().mockResolvedValue({ ...ENABLED, thirdPartyConsent: false });
    render(wrap(<CoachPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('coach.consentRequired'))).toBeDefined();
    expect(screen.getByRole('link', { name: t('coach.consentLink') }).getAttribute('href')).toBe(
      '/me#consents-heading',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the privacy note, the quota and a described question field', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    render(wrap(<CoachPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('coach.privacy'))).toBeDefined();
    expect(screen.getByText(t('coach.quotaOther', { remaining: 4, limit: 10 }))).toBeDefined();
    const field = screen.getByLabelText(t('coach.question.label'));
    expect(field.getAttribute('aria-describedby')).toBe(
      'coach-question-hint coach-question-counter',
    );
    expect(field.getAttribute('maxlength')).toBe('500');
    expect(
      (screen.getByRole('button', { name: t('coach.submit') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks for a stream and renders a JSON answer in a live region', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    let resolvePost: (value: Response) => void = () => undefined;
    const postStream = vi.fn<PostStream>(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('  How do I progress?  ');
    submit();
    await flush();

    expect(postStream).toHaveBeenCalledWith(
      '/v1/coach/ask',
      { question: 'How do I progress?', locale: 'en' },
      expect.objectContaining({ headers: { Accept: 'text/event-stream' } }),
    );
    const thinking = screen.getByText(t('coach.thinking'));
    const region = thinking.closest('[aria-live]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-busy')).toBe('true');

    resolvePost(jsonResponse(ANSWER));
    await settle();

    expect(region?.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText(t('coach.thinking'))).toBeNull();
    const answer = screen.getByRole('article', { name: t('coach.answer.title') });
    expect(region?.contains(answer)).toBe(true);
    expect(screen.getByText(ANSWER.advice.summary)).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('note').textContent).toContain(ANSWER.advice.caution);
    expect(screen.getByText(t('coach.quotaOther', { remaining: 3, limit: 10 }))).toBeDefined();
  });

  it('disables the form once the daily quota is used up (real client 429)', async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/v1/coach/ask')
          ? new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Too Many Requests',
                status: 429,
                code: 'coach_quota_exceeded',
              }),
              {
                status: 429,
                headers: { 'content-type': 'application/problem+json', 'retry-after': '3600' },
              },
            )
          : new Response(JSON.stringify(ENABLED), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    const client = createApiClient({
      baseUrl: 'https://api.test',
      getToken: () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    render(wrap(<CoachPanel client={client} t={t} />));
    await flush();
    await flush();

    typeQuestion('Again?');
    submit();
    await flush();
    await flush();

    expect(screen.getByRole('alert').textContent).toBe(t('coach.quotaExhausted'));
    expect(
      (screen.getByRole('button', { name: t('coach.submit') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('explains a burst limit and an outage before the stream opens', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const postStream = vi
      .fn<PostStream>()
      .mockRejectedValueOnce(new ApiError('slow down', 429))
      .mockRejectedValueOnce(new ApiServerError('not configured', 503));
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('Why?');
    submit();
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('coach.errors.rateLimited'));

    submit();
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('coach.errors.unavailable'));
  });

  it('asks for the consent again on 403 and hides the coach on 404', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const postStream = vi
      .fn<PostStream>()
      .mockRejectedValueOnce(new ApiError('Forbidden', 403))
      .mockRejectedValueOnce(new ApiError('Not Found', 404));
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('Why?');
    submit();
    await flush();
    expect(screen.getByText(t('coach.consentRequired'))).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    cleanup();

    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();
    typeQuestion('Why?');
    submit();
    await flush();
    expect(screen.getByText(t('coach.disabled'))).toBeDefined();
  });

  it('renders partial snapshots outside the live region, then announces the done answer', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const stream = eventStream();
    const postStream = vi.fn<PostStream>().mockResolvedValue(stream.response);
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('How do I progress?');
    submit();
    await settle();
    await stream.send('partial', { summary: 'Your squat' });

    const draft = screen.getByText('Your squat');
    const region = document.querySelector('[aria-live]');
    expect(region?.contains(draft)).toBe(false);
    expect(draft.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(t('coach.answer.provisional'))).toBeDefined();
    expect(screen.queryByText(t('coach.thinking'))).toBeNull();
    expect(region?.getAttribute('aria-busy')).toBe('true');
    expect(region?.textContent).toBe('');

    await stream.send('partial', {
      summary: 'Your squat volume',
      recommendations: [{ title: 'Add a back-off' }],
    });
    expect(screen.getByText('Your squat volume')).toBeDefined();
    expect(screen.getByText('Add a back-off')).toBeDefined();

    await stream.send('done', ANSWER);

    expect(screen.queryByText('Your squat volume')).toBeNull();
    expect(screen.queryByText(t('coach.answer.provisional'))).toBeNull();
    expect(region?.getAttribute('aria-busy')).toBe('false');
    const answer = screen.getByRole('article', { name: t('coach.answer.title') });
    expect(region?.contains(answer)).toBe(true);
    expect(screen.getByText(ANSWER.advice.summary)).toBeDefined();
    expect(screen.getByText(t('coach.quotaOther', { remaining: 3, limit: 10 }))).toBeDefined();
  });

  it('discards the partial answer on an error event', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const stream = eventStream();
    const postStream = vi.fn<PostStream>().mockResolvedValue(stream.response);
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('How do I progress?');
    submit();
    await settle();
    await stream.send('partial', { summary: 'Half an answer' });
    expect(screen.getByText('Half an answer')).toBeDefined();

    await stream.send('error', UPSTREAM_FAILED);

    expect(screen.queryByText('Half an answer')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(t('coach.errors.unavailable'));
    expect(
      (screen.getByRole('button', { name: t('coach.submit') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows the unavailable message when the stream ends without an answer', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const stream = eventStream();
    const postStream = vi.fn<PostStream>().mockResolvedValue(stream.response);
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('How do I progress?');
    submit();
    await settle();
    await stream.send('partial', { summary: 'Cut short' });
    await stream.close();

    expect(screen.queryByText('Cut short')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(t('coach.errors.unavailable'));
  });

  it('aborts the request when the page unmounts', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const stream = eventStream();
    const postStream = vi.fn<PostStream>().mockResolvedValue(stream.response);
    const { unmount } = render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('How do I progress?');
    submit();
    await settle();
    const signal = signalOf(postStream);
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('aborts the previous request when the member asks again', async () => {
    const get = vi.fn().mockResolvedValue(ENABLED);
    const first = eventStream();
    const second = eventStream();
    const postStream = vi
      .fn<PostStream>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    render(wrap(<CoachPanel client={fakeClient(get, postStream)} t={t} />));
    await flush();

    typeQuestion('First question?');
    submit();
    await settle();
    await first.send('partial', { summary: 'First draft' });

    typeQuestion('Second question?');
    const form = screen.getByLabelText(t('coach.question.label')).closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.submit(form);
    await settle();

    expect(signalOf(postStream, 0).aborted).toBe(true);
    expect(signalOf(postStream, 1).aborted).toBe(false);
    expect(screen.queryByText('First draft')).toBeNull();

    await first.send('partial', { summary: 'Late first draft' });
    expect(screen.queryByText('Late first draft')).toBeNull();

    await second.send('done', ANSWER);
    expect(screen.getByText(ANSWER.advice.summary)).toBeDefined();
  });

  it('uses the singular quota and counter strings for one', async () => {
    const get = vi.fn().mockResolvedValue({ ...ENABLED, quota: { ...QUOTA, remaining: 1 } });
    render(wrap(<CoachPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('coach.quotaOne', { limit: 10 }))).toBeDefined();
    typeQuestion('?');
    expect(screen.getByText(t('coach.question.counterOne', { max: 500 }))).toBeDefined();
  });

  it('shows an alert with a retry button when the status cannot be loaded', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ENABLED);
    render(wrap(<CoachPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(t('coach.question.label'))).toBeDefined();
  });
});

describe('<CoachLink />', () => {
  it('renders the link only when the flag is on', async () => {
    const on = vi.fn().mockResolvedValue(ENABLED);
    render(wrap(<CoachLink client={fakeClient(on)} t={t} />));
    await flush();
    expect(screen.getByRole('link', { name: t('coach.link') }).getAttribute('href')).toBe(
      '/me/coach',
    );
    cleanup();

    const off = vi.fn().mockResolvedValue({ enabled: false });
    render(wrap(<CoachLink client={fakeClient(off)} t={t} />));
    await flush();
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();

    const failing = vi.fn().mockRejectedValue(new Error('down'));
    render(wrap(<CoachLink client={fakeClient(failing)} t={t} />));
    await flush();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
