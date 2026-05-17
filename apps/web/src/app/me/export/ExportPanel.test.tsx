/**
 * Component tests for `<ExportPanel />`.
 *
 * The fake API client is injected through the `client` prop so we
 * never touch module-level globals. Each test asserts a specific
 * contract clause:
 *   1. Renders the request button.
 *   2. Click → POST `/v1/members/me/export` with body `{}` and
 *      `Idempotency-Key` header; button disables while pending.
 *   3. Success (`{ jobId: 'job-1' }`) → pending banner + jobId shown.
 *   4. Error → alert visible, button becomes clickable again.
 *
 * @see Requirements 4.1, 5.1.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { ExportPanel } from './ExportPanel';

import type { ApiClient } from '../../../lib/api/client';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('fr');

/** Build a fully-typed fake client. Individual tests override `post`. */
function buildFakeClient(overrides?: Partial<ApiClient>): ApiClient & {
  readonly post: ReturnType<typeof vi.fn>;
} {
  const defaults = {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    patch: vi.fn(),
    del: vi.fn(),
  };
  return {
    ...defaults,
    ...overrides,
  } as ApiClient & { readonly post: ReturnType<typeof vi.fn> };
}

/** Wrap in `<LocaleProvider>` to satisfy `useLocale()`. */
function wrap(children: ReactNode): ReactElement {
  return <LocaleProvider locale="fr">{children}</LocaleProvider>;
}

afterEach(() => {
  cleanup();
});

describe('<ExportPanel />', () => {
  it('renders the export request button', () => {
    const client = buildFakeClient();
    render(wrap(<ExportPanel client={client} t={t} />));

    const button = screen.getByRole('button', {
      name: t('rgpd.export.request'),
    });
    expect(button).toBeDefined();
  });

  it('POSTs to /v1/members/me/export with {} body + Idempotency-Key header, disables while pending', async () => {
    // Never-resolving post keeps the panel in the `pending` state.
    const client = buildFakeClient({
      post: vi.fn(() => new Promise(() => undefined)) as unknown as ApiClient['post'],
    });
    render(wrap(<ExportPanel client={client} t={t} />));

    const button = screen.getByRole('button', {
      name: t('rgpd.export.request'),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(button);
      // Allow the internal `setStatus('pending')` to flush.
      await Promise.resolve();
    });

    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body, init] = client.post.mock.calls[0] as [
      string,
      unknown,
      { headers?: Record<string, string> } | undefined,
    ];
    expect(path).toBe('/v1/members/me/export');
    expect(body).toEqual({});
    expect(init?.headers?.['Idempotency-Key']).toBeDefined();
    expect(typeof init?.headers?.['Idempotency-Key']).toBe('string');

    // While pending the button shows the loading label and is disabled.
    const pendingButton = screen.getByRole('button', {
      name: t('common.loading'),
    }) as HTMLButtonElement;
    expect(pendingButton.disabled).toBe(true);
  });

  it('shows the pending banner and jobId on success', async () => {
    const client = buildFakeClient({
      post: vi.fn().mockResolvedValue({
        jobId: 'job-1',
      }) as unknown as ApiClient['post'],
    });
    render(wrap(<ExportPanel client={client} t={t} />));

    const button = screen.getByRole('button', {
      name: t('rgpd.export.request'),
    });

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Pending banner uses the "export in progress" copy — scope
    // the query to the status region because the same phrase also
    // doubles as the panel's introductory paragraph.
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(t('rgpd.export.pending'));

    // jobId surfaces inside a <dd>.
    const jobIdValue = screen.getByText('job-1');
    expect(jobIdValue.tagName.toLowerCase()).toBe('dd');
  });

  it('surfaces a generic error alert when the request fails, re-enabling the button', async () => {
    const client = buildFakeClient({
      post: vi.fn().mockRejectedValue(new Error('boom')) as unknown as ApiClient['post'],
    });
    render(wrap(<ExportPanel client={client} t={t} />));

    const button = screen.getByRole('button', {
      name: t('rgpd.export.request'),
    }) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(t('errors.generic'));

    // Button is clickable again (status reverted out of `pending`).
    const nextButton = screen.getByRole('button', {
      name: t('rgpd.export.request'),
    }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);
  });
});
