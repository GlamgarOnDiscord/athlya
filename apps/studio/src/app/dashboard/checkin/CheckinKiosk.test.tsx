/**
 * Kiosk behaviour that does not need a real camera: the camera status
 * shown when it cannot open, the check-in outcomes, and the greeting.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { CheckinKiosk } from './CheckinKiosk';

const t = createTranslator('en');
const post = vi.fn();

vi.mock('../../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ accessToken: 'jwt' }),
}));

vi.mock('../../../lib/api/buildClient', () => ({
  useApiClient: () => ({ get: vi.fn(), post, patch: vi.fn(), del: vi.fn() }),
}));

vi.mock('./qr-frame-decoder', () => ({
  createFrameDecoder: () => Promise.resolve(() => Promise.resolve(null)),
}));

function setCamera(getUserMedia: (() => Promise<MediaStream>) | undefined): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: getUserMedia === undefined ? undefined : { getUserMedia },
  });
}

function renderKiosk(): void {
  render(
    <LocaleProvider locale="en">
      <CheckinKiosk />
    </LocaleProvider>,
  );
}

function submitManually(token: string): void {
  fireEvent.change(screen.getByLabelText(t('studio.checkin.manualLabel')), {
    target: { value: token },
  });
  fireEvent.click(screen.getByRole('button', { name: t('studio.checkin.manualSubmit') }));
}

beforeEach(() => {
  post.mockReset();
});

afterEach(() => {
  cleanup();
  setCamera(undefined);
});

describe('<CheckinKiosk /> camera', () => {
  it('says the browser cannot open a camera and keeps the manual entry', () => {
    setCamera(undefined);
    renderKiosk();
    expect(screen.getByTestId('checkin-camera-status').textContent).toContain(
      t('studio.checkin.camera.unsupported'),
    );
    expect(screen.getByLabelText(t('studio.checkin.manualLabel'))).toBeDefined();
  });

  it('explains how to unblock a refused camera instead of showing a black video', async () => {
    setCamera(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    renderKiosk();
    await waitFor(() => {
      expect(screen.getByTestId('checkin-camera-status').textContent).toContain(
        t('studio.checkin.camera.denied'),
      );
    });
  });
});

describe('<CheckinKiosk /> outcomes', () => {
  it('names the member already checked in for the class', async () => {
    setCamera(undefined);
    post.mockRejectedValue(
      new ApiError('rejected', 422, {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'already_checked_in',
      }),
    );
    renderKiosk();
    await act(async () => {
      submitManually('token');
      await Promise.resolve();
    });
    expect(await screen.findByText(t('studio.checkin.errors.already_checked_in'))).toBeDefined();
  });

  it('shows the hourly limit message on checkin_limit_reached', async () => {
    setCamera(undefined);
    post.mockRejectedValue(
      new ApiError('rejected', 429, {
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        code: 'checkin_limit_reached',
      }),
    );
    renderKiosk();
    await act(async () => {
      submitManually('token');
      await Promise.resolve();
    });
    expect(await screen.findByText(t('studio.checkin.errors.checkin_limit_reached'))).toBeDefined();
  });

  it('falls back to the generic message for a code it does not know', async () => {
    setCamera(undefined);
    post.mockRejectedValue(
      new ApiError('rejected', 422, {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'something_new',
      }),
    );
    renderKiosk();
    await act(async () => {
      submitManually('token');
      await Promise.resolve();
    });
    expect(await screen.findByText(t('studio.checkin.errors.generic'))).toBeDefined();
  });

  it('greets without a name when the member card came back empty', async () => {
    setCamera(undefined);
    post.mockResolvedValue({
      success: true,
      reservationId: 'r1',
      member: { id: 'm1', displayName: '', avatarUrl: null },
    });
    renderKiosk();
    await act(async () => {
      submitManually('token');
      await Promise.resolve();
    });
    expect(await screen.findByText(t('studio.checkin.successNoName'))).toBeDefined();
  });
});
