/**
 * Component tests for `<CheckinPanel />`: the QR code, its refresh
 * shortly before expiry, the hidden-tab pause and the failure states.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { CHECKIN_TOKEN_PATH, CheckinPanel, REFRESH_MARGIN_MS } from './CheckinPanel';

import type { ApiClient } from '../../../lib/api/client';

const t = createTranslator('en');
const START = Date.parse('2026-10-20T10:00:00.000Z');
const TTL_MS = 120_000;

function tokenFrom(n: number): { token: string; expiresAt: string } {
  return {
    token: `header.payload-${String(n)}.signature`,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  };
}

function fakeClient(post: ReturnType<typeof vi.fn>): ApiClient {
  return { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as unknown as ApiClient;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderPanel(post: ReturnType<typeof vi.fn>): void {
  render(
    <LocaleProvider locale="en">
      <CheckinPanel client={fakeClient(post)} t={t} />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<CheckinPanel />', () => {
  it('shows the QR code with its countdown', async () => {
    let n = 0;
    const post = vi.fn().mockImplementation(() => Promise.resolve(tokenFrom((n += 1))));
    renderPanel(post);
    await flush();
    expect(post).toHaveBeenCalledWith(CHECKIN_TOKEN_PATH, {});
    expect(screen.getByTestId('checkin-qr')).toBeDefined();
    expect(screen.getByText(t('checkin.qrExpiresIn', { seconds: 120 }))).toBeDefined();
  });

  it('fetches the next code 15 s before the current one expires', async () => {
    let n = 0;
    const post = vi.fn().mockImplementation(() => Promise.resolve(tokenFrom((n += 1))));
    renderPanel(post);
    await flush();
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(TTL_MS - REFRESH_MARGIN_MS - 1_000);
    });
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden and refreshes an expiring code on return', async () => {
    let n = 0;
    const post = vi.fn().mockImplementation(() => Promise.resolve(tokenFrom((n += 1))));
    renderPanel(post);
    await flush();

    act(() => setVisibility('hidden'));
    await act(async () => {
      vi.advanceTimersByTime(TTL_MS);
    });
    expect(post).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps a still-valid code when the tab comes back early', async () => {
    let n = 0;
    const post = vi.fn().mockImplementation(() => Promise.resolve(tokenFrom((n += 1))));
    renderPanel(post);
    await flush();

    act(() => setVisibility('hidden'));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => setVisibility('visible'));
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('checkin-qr')).toBeDefined();
  });

  it('shows an error and retries after a failure', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('boom', 500))
      .mockImplementation(() => Promise.resolve(tokenFrom(2)));
    renderPanel(post);
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('checkin.loadError'));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('checkin-qr')).toBeDefined();
  });

  it('says a connection is needed when offline without a valid code', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const post = vi.fn();
    renderPanel(post);
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(t('checkin.offline'));
    online.mockRestore();
  });
});
