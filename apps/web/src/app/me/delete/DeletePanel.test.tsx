/**
 * Component tests for `<DeletePanel />`.
 *
 * Five cases covering the contract:
 *   1. Initial render: only the outer confirm button, no modal.
 *   2. Click outer button → modal opens.
 *   3. Confirm button disabled until the user types the exact word.
 *   4. Typing "SUPPRIMER" enables the confirm button.
 *   5. Click confirm → `del` called, success triggers router redirect.
 *
 * `next/navigation` is mocked at module level so `useRouter()` returns
 * our spy.
 *
 * @see Requirements 4.1, 5.1.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { DeletePanel } from './DeletePanel';

import type { ApiClient } from '../../../lib/api/client';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('fr');

function buildFakeClient(overrides?: Partial<ApiClient>): ApiClient & {
  readonly del: ReturnType<typeof vi.fn>;
} {
  const defaults = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...defaults,
    ...overrides,
  } as ApiClient & { readonly del: ReturnType<typeof vi.fn> };
}

function wrap(children: ReactNode): ReactElement {
  return <LocaleProvider locale="fr">{children}</LocaleProvider>;
}

beforeEach(() => {
  routerPushMock.mockReset();

  // `<DeletePanel />` calls `fetch('/api/auth/logout', ...)` on
  // successful delete — stub it out so we don't hit the network.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<DeletePanel />', () => {
  it('initial render: only the outer confirm button, no modal', () => {
    const client = buildFakeClient();
    render(wrap(<DeletePanel client={client} t={t} />));

    const outer = screen.getByRole('button', {
      name: t('rgpd.delete.confirm'),
    });
    expect(outer).toBeDefined();

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the outer confirm button opens the modal', () => {
    const client = buildFakeClient();
    render(wrap(<DeletePanel client={client} t={t} />));

    fireEvent.click(screen.getByRole('button', { name: t('rgpd.delete.confirm') }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
  });

  it('the confirm button is disabled until the user types the exact word', () => {
    const client = buildFakeClient();
    render(wrap(<DeletePanel client={client} t={t} />));

    fireEvent.click(screen.getByRole('button', { name: t('rgpd.delete.confirm') }));

    const confirmButton = screen.getByRole('button', {
      name: t('rgpd.delete.confirmButton'),
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    const input = screen.getByLabelText(
      t('rgpd.delete.confirmInstruction', { word: t('rgpd.delete.confirmWord') }),
    ) as HTMLInputElement;
    // Partial input — still disabled.
    fireEvent.change(input, { target: { value: 'SUPPRIM' } });
    expect(confirmButton.disabled).toBe(true);
  });

  it('typing "SUPPRIMER" enables the confirm button', () => {
    const client = buildFakeClient();
    render(wrap(<DeletePanel client={client} t={t} />));

    fireEvent.click(screen.getByRole('button', { name: t('rgpd.delete.confirm') }));

    const input = screen.getByLabelText(
      t('rgpd.delete.confirmInstruction', { word: t('rgpd.delete.confirmWord') }),
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'SUPPRIMER' } });

    const confirmButton = screen.getByRole('button', {
      name: t('rgpd.delete.confirmButton'),
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
  });

  it('clicking confirm calls DELETE /v1/auth/me and routes to "/" on success', async () => {
    const client = buildFakeClient();
    render(wrap(<DeletePanel client={client} t={t} />));

    fireEvent.click(screen.getByRole('button', { name: t('rgpd.delete.confirm') }));

    const input = screen.getByLabelText(
      t('rgpd.delete.confirmInstruction', { word: t('rgpd.delete.confirmWord') }),
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'SUPPRIMER' } });

    const confirmButton = screen.getByRole('button', {
      name: t('rgpd.delete.confirmButton'),
    });

    await act(async () => {
      fireEvent.click(confirmButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.del).toHaveBeenCalledTimes(1);
    const [path, init] = client.del.mock.calls[0] as [
      string,
      { headers?: Record<string, string> } | undefined,
    ];
    expect(path).toBe('/v1/auth/me');
    expect(init?.headers?.['Idempotency-Key']).toBeDefined();

    expect(routerPushMock).toHaveBeenCalledWith('/');
  });
});
