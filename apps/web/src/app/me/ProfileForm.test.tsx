/**
 * Component tests for `<ProfileForm />`.
 *
 * The fake API client is injected through the `client` prop so we
 * never touch module-level globals. Each test renders the form with
 * a minimal profile fixture and asserts against a specific contract
 * clause:
 *   1. Email renders read-only with its value, displayName populated.
 *   2. Counter reflects the current length and updates on change.
 *   3. `maxLength={80}` is present on the displayName input.
 *   4. Submit button disables while the PATCH is in flight.
 *   5. Success banner appears on resolve and disappears after 3s.
 *   6. 422 `validation_error` surfaces per-field errors in the
 *      `role="alert"` slot.
 *
 * @see Requirements 3.1, 3.2, 3.4.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api/client';
import { createTranslator } from '../../lib/i18n/t';

import { ProfileForm } from './ProfileForm';

import type { MeProfile } from './ProfileSection';
import type { ApiClient } from '../../lib/api/client';

const t = createTranslator('fr');

const BASE_PROFILE: MeProfile = {
    email: 'a@b.co',
    displayName: 'Bob',
    avatarUrl: null,
};

/** Build a fully-typed fake client. Individual tests override `patch`. */
function buildFakeClient(
    overrides?: Partial<ApiClient>,
): ApiClient & {
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
    vi.useRealTimers();
});

describe('<ProfileForm />', () => {
    it('renders email (read-only) and displayName populated', () => {
        const client = buildFakeClient();
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        const email = screen.getByLabelText(t('profile.email')) as HTMLInputElement;
        expect(email.value).toBe('a@b.co');
        expect(email.readOnly).toBe(true);

        const display = screen.getByLabelText(
            t('profile.displayName'),
        ) as HTMLInputElement;
        expect(display.value).toBe('Bob');
    });

    it('counter reflects length and updates on input change', () => {
        const client = buildFakeClient();
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        // "Bob" → 3 / 80
        expect(screen.getByText('3 / 80')).toBeDefined();

        const display = screen.getByLabelText(
            t('profile.displayName'),
        ) as HTMLInputElement;
        fireEvent.change(display, { target: { value: 'Bob Xy' } });

        expect(screen.getByText('6 / 80')).toBeDefined();
    });

    it('displayName input carries maxLength=80', () => {
        const client = buildFakeClient();
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        const display = screen.getByLabelText(
            t('profile.displayName'),
        ) as HTMLInputElement;
        expect(display.getAttribute('maxlength')).toBe('80');
    });

    it('disables the submit button while the PATCH is pending', async () => {
        // Never-resolving patch keeps the form in the `pending` state.
        // Cast to `unknown` first because TS resolves the generic `patch`
        // return to `Promise<never>` when the mock implementation never
        // returns, which is incompatible with `ApiClient['patch']`.
        const client = buildFakeClient({
            patch: vi.fn(
                () => new Promise(() => undefined),
            ) as unknown as ApiClient['patch'],
        });
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        const submit = screen.getByRole('button', {
            name: t('profile.save'),
        }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);

        await act(async () => {
            fireEvent.submit(submit.closest('form') as HTMLFormElement);
        });

        expect(submit.disabled).toBe(true);
    });

    it('shows the success banner and hides it after 3 s', async () => {
        vi.useFakeTimers();

        const client = buildFakeClient();
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        const submit = screen.getByRole('button', { name: t('profile.save') });

        await act(async () => {
            fireEvent.submit(submit.closest('form') as HTMLFormElement);
            // Let the micro-task queue drain so the resolved PATCH
            // promise's `.then` handlers run before we advance timers.
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.getByText(t('profile.updateSuccess'))).toBeDefined();

        await act(async () => {
            vi.advanceTimersByTime(3_000);
        });

        expect(screen.queryByText(t('profile.updateSuccess'))).toBeNull();
    });

    it('maps 422 problem.errors[] onto per-field alerts', async () => {
        const client = buildFakeClient({
            patch: vi.fn().mockRejectedValue(
                new ApiError('validation_error', 422, {
                    type: 'about:blank',
                    title: 'validation_error',
                    status: 422,
                    code: 'validation_error',
                    errors: [
                        {
                            path: 'displayName',
                            message: 'Too long',
                        },
                    ],
                }),
            ) as unknown as ApiClient['patch'],
        });
        render(<ProfileForm profile={BASE_PROFILE} client={client} t={t} />);

        const submit = screen.getByRole('button', { name: t('profile.save') });

        await act(async () => {
            fireEvent.submit(submit.closest('form') as HTMLFormElement);
            await Promise.resolve();
            await Promise.resolve();
        });

        const alert = screen.getByText('Too long');
        expect(alert.getAttribute('role')).toBe('alert');
    });
});
