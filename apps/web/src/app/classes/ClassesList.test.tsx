/**
 * Component tests for `<ClassesList />`.
 *
 * Uses a fake API client injected via the `client` prop so no real
 * fetch ever runs. Six focused cases:
 *   1. Initial loading state before `GET` resolves.
 *   2. Successful fetch renders the grid of cards.
 *   3. Empty response → shows the empty-state message.
 *   4. Fetch error → shows the error block + retry button.
 *   5. Booking: optimistic decrement on click, success banner on 201.
 *   6. Booking 422 class_in_past: reverts decrement, shows error on card.
 *
 * The `<LocaleProvider>` wrapper matches the pattern used by every
 * other client-component test in the app.
 *
 * @see Requirements 7.1, 7.2, 8.1, 8.2, 20.3.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ bootResolved: true }),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { ApiError } from '../../lib/api/client';
import { LocaleProvider } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import { ClassesList } from './ClassesList';

import type { ApiClient } from '../../lib/api/client';
import type { ClassWithRemaining } from '@athlya/shared/schemas/api';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('fr');

function renderWithLocale(ui: ReactNode): ReturnType<typeof render> {
  return render(<LocaleProvider locale="fr">{ui}</LocaleProvider>);
}

/** Cast helper — the shared schema brands ids and datetimes. */
function klass(overrides: Partial<ClassWithRemaining>): ClassWithRemaining {
  const base: ClassWithRemaining = {
    id: '11111111-1111-4111-8111-111111111111' as ClassWithRemaining['id'],
    studioId: '22222222-2222-4222-8222-222222222222' as ClassWithRemaining['studioId'],
    coachId: null,
    title: 'CrossFit',
    startsAt: '2025-06-15T10:30:00.000Z' as ClassWithRemaining['startsAt'],
    durationMin: 60,
    capacity: 12,
    version: 0,
    createdAt: '2025-01-01T00:00:00.000Z' as ClassWithRemaining['createdAt'],
    remaining: 4,
  };
  return { ...base, ...overrides };
}

/** Minimal fake client; individual tests override `get` and `post`. */
function buildFakeClient(overrides?: Partial<ApiClient>): ApiClient & {
  readonly get: ReturnType<typeof vi.fn>;
  readonly post: ReturnType<typeof vi.fn>;
} {
  const defaults = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  };
  return {
    ...defaults,
    ...overrides,
  } as ApiClient & {
    readonly get: ReturnType<typeof vi.fn>;
    readonly post: ReturnType<typeof vi.fn>;
  };
}

/** Render, then flush the microtask queue so the fetch effect resolves. */
async function renderAndSettle(ui: ReactElement): Promise<void> {
  await act(async () => {
    renderWithLocale(ui);
    // Two ticks: one for the promise itself, one for the state update.
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
});

describe('<ClassesList />', () => {
  it('renders the loading state initially', () => {
    const client = buildFakeClient({
      // Never resolves — the list stays on loading.
      get: vi.fn(() => new Promise(() => undefined)) as unknown as ApiClient['get'],
    });
    renderWithLocale(<ClassesList client={client} t={t} />);

    // Loading state renders skeleton placeholders, no interactive buttons.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a card for each class in the fetched items', async () => {
    const items = [
      klass({
        id: '11111111-1111-4111-8111-111111111111' as ClassWithRemaining['id'],
        title: 'CrossFit',
        remaining: 4,
      }),
      klass({
        id: '33333333-3333-4333-8333-333333333333' as ClassWithRemaining['id'],
        title: 'Yoga',
        remaining: 6,
        capacity: 10,
      }),
    ];
    const client = buildFakeClient({
      get: vi.fn().mockResolvedValue({ items }) as unknown as ApiClient['get'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText('CrossFit')).toBeDefined();
    expect(screen.getByText('Yoga')).toBeDefined();
    // Both CTAs are rendered — aria-label includes the class title.
    const ctas = screen.getAllByRole('button', {
      name: (n) => n.startsWith(t('classes.card.book')),
    });
    expect(ctas.length).toBe(2);
  });

  it('shows the empty-state message when items is empty', async () => {
    const client = buildFakeClient({
      get: vi.fn().mockResolvedValue({
        items: [],
      }) as unknown as ApiClient['get'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText(t('classes.list.empty'))).toBeDefined();
  });

  it('shows an error + retry button when the fetch rejects', async () => {
    const client = buildFakeClient({
      get: vi.fn().mockRejectedValue(new Error('network down')) as unknown as ApiClient['get'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText(t('errors.generic'))).toBeDefined();
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeDefined();
  });

  it('optimistically decrements on click and confirms on 201', async () => {
    const item = klass({ remaining: 4 });
    const client = buildFakeClient({
      get: vi.fn().mockResolvedValue({
        items: [item],
      }) as unknown as ApiClient['get'],
      post: vi.fn().mockResolvedValue({
        status: 'confirmed',
        reservation: {},
      }) as unknown as ApiClient['post'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    // Pre-click: remaining is 4 / 12.
    expect(screen.getByText('4 / 12')).toBeDefined();

    const cta = screen.getByRole('button', {
      name: (n) => n.startsWith(t('classes.card.book')),
    });
    await act(async () => {
      fireEvent.click(cta);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Post-click: remaining dropped to 3 / 12 and stayed there.
    expect(screen.getByText('3 / 12')).toBeDefined();
    // Success toast fired.
    expect(toastMock.success).toHaveBeenCalledWith(t('reservations.confirmed'));

    // POST called exactly once, with classId + Idempotency-Key.
    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body, init] = client.post.mock.calls[0] as [
      string,
      { classId: string },
      { headers?: Record<string, string> } | undefined,
    ];
    expect(path).toBe('/v1/reservations');
    expect(body).toEqual({ classId: item.id });
    expect(init?.headers?.['Idempotency-Key']).toBeDefined();
  });

  it('reverts the optimistic decrement and shows error on 422 class_in_past', async () => {
    const item = klass({ remaining: 4 });
    const client = buildFakeClient({
      get: vi.fn().mockResolvedValue({
        items: [item],
      }) as unknown as ApiClient['get'],
      post: vi.fn().mockRejectedValue(
        new ApiError('class_in_past', 422, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          code: 'class_in_past',
        }),
      ) as unknown as ApiClient['post'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    const cta = screen.getByRole('button', {
      name: (n) => n.startsWith(t('classes.card.book')),
    });
    await act(async () => {
      fireEvent.click(cta);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Decrement reverted: back to 4 / 12.
    expect(screen.getByText('4 / 12')).toBeDefined();
    // Error surfaced on the card.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(t('errors.classInPast'));
  });
});
