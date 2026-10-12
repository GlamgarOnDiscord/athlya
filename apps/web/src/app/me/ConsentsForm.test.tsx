/**
 * Component tests for `<ConsentsForm />`.
 *
 * Four cases — enough to prove the contract:
 *   1. `version` + `updatedAt` appear as `<dd>` values.
 *   2. Toggling `marketing` flips the input's `checked` state.
 *   3. Submit sends exactly the three boolean flags to
 *      `PATCH /v1/members/me/consents`.
 *   4. 422 `validation_error` surfaces through the `role="alert"`
 *      region.
 *
 * @see Requirements 3.1, 3.3.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/i18n/LocaleContext', () => ({
  useLocale: () => 'fr',
}));

import { ApiError } from '../../lib/api/client';
import { createTranslator } from '../../lib/i18n/t';

import { ConsentsForm } from './ConsentsForm';

import type { ApiClient } from '../../lib/api/client';
import type { Consents } from '@athlya/shared/schemas';

const t = createTranslator('fr');

const BASE_CONSENTS: Consents = {
  marketing: false,
  analytics: true,
  thirdParty: false,
  version: '2025-01',
  updatedAt: '2025-01-15T10:00:00.000Z',
};

function buildFakeClient(overrides?: Partial<ApiClient>): ApiClient & {
  readonly patch: ReturnType<typeof vi.fn>;
} {
  const defaults = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
    del: vi.fn(),
  };
  return {
    ...defaults,
    ...overrides,
  } as ApiClient & { readonly patch: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  cleanup();
});

describe('<ConsentsForm />', () => {
  it('renders version and updatedAt as <dd> entries', () => {
    const client = buildFakeClient();
    render(<ConsentsForm consents={BASE_CONSENTS} client={client} t={t} />);

    // Both values surface somewhere in the page.
    const version = screen.getByText('2025-01');
    // `updatedAt` is rendered through `Intl.DateTimeFormat('fr', { dateStyle: 'medium' })`
    // (see ConsentsForm.tsx). Asserting on the formatted output keeps the test
    // tied to the user-visible rendering rather than the raw ISO string.
    const updatedAt = screen.getByText('15 janv. 2025');
    expect(version.tagName.toLowerCase()).toBe('dd');
    expect(updatedAt.tagName.toLowerCase()).toBe('dd');
  });

  it('toggling marketing flips the checked state', () => {
    const client = buildFakeClient();
    render(<ConsentsForm consents={BASE_CONSENTS} client={client} t={t} />);

    // base-ui Checkbox renders both a `<span role="checkbox">` (the visible,
    // a11y-friendly trigger) and a hidden `<input type="checkbox">` (so the
    // surrounding form submit sees the value). Both are siblings of the shared
    // `<label>`, so `getByLabelText` matches twice — query by role to pin the
    // assertion to the user-visible trigger and read `aria-checked` from it.
    const trigger = screen.getByRole('checkbox', { name: t('consents.marketing') });
    expect(trigger.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-checked')).toBe('true');
  });

  it('submits only the three boolean flags via PATCH', async () => {
    const client = buildFakeClient();
    render(<ConsentsForm consents={BASE_CONSENTS} client={client} t={t} />);

    const submit = screen.getByRole('button', { name: t('consents.save') });

    await act(async () => {
      fireEvent.submit(submit.closest('form') as HTMLFormElement);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.patch).toHaveBeenCalledTimes(1);
    const [path, body, init] = client.patch.mock.calls[0] as [
      string,
      Record<string, boolean>,
      { headers?: Record<string, string> } | undefined,
    ];
    expect(path).toBe('/v1/members/me/consents');
    expect(body).toEqual({
      marketing: false,
      analytics: true,
      thirdParty: false,
    });
    // Idempotency-Key must be attached.
    expect(init?.headers?.['Idempotency-Key']).toBeDefined();
  });

  it('surfaces 422 validation errors through aria-live region', async () => {
    const client = buildFakeClient({
      patch: vi.fn().mockRejectedValue(
        new ApiError('validation_error', 422, {
          type: 'about:blank',
          title: 'validation_error',
          status: 422,
          code: 'validation_error',
          errors: [
            {
              path: 'marketing',
              message: 'Must be boolean',
            },
          ],
        }),
      ) as unknown as ApiClient['patch'],
    });
    render(<ConsentsForm consents={BASE_CONSENTS} client={client} t={t} />);

    const submit = screen.getByRole('button', { name: t('consents.save') });

    await act(async () => {
      fireEvent.submit(submit.closest('form') as HTMLFormElement);
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = screen.getByText('Must be boolean');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('polite');
  });
});
