/**
 * Component tests for `<ClassesList />`.
 *
 * Uses a fake API client injected via the `client` prop so no real
 * fetch ever runs: the loading, ready, empty and error states, the
 * classes the member already holds (`GET /v1/reservations/me`), the
 * booking outcomes with their live-region announcement, and the week
 * strip (one tab stop, arrow keys, paging between the two weeks). The
 * clock is pinned so the strip's days are known.
 *
 * The `<LocaleProvider>` wrapper matches the pattern used by every
 * other client-component test in the app.
 *
 * @see Requirements 7.1, 7.2, 8.1, 8.2, 20.3.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/auth/AuthContext', () => ({
  useAuth: () => ({ bootResolved: true }),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { ApiError } from '../../lib/api/client';
import { LocaleProvider } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

import { ClassesList } from './ClassesList';

import type { ApiClient } from '../../lib/api/client';
import type { ClassWithRemaining } from '@athlya/shared/schemas/api';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('fr');

/** Clock of every test: the week strip starts on this day. */
const NOW = new Date(2026, 9, 20, 8, 0);

/** Local time `hour`:`minute`, `dayOffset` days after {@link NOW}. */
function at(dayOffset: number, hour: number, minute = 0): ClassWithRemaining['startsAt'] {
  return new Date(
    2026,
    9,
    20 + dayOffset,
    hour,
    minute,
  ).toISOString() as ClassWithRemaining['startsAt'];
}

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
    startsAt: at(0, 18, 30),
    durationMin: 60,
    capacity: 12,
    version: 0,
    createdAt: '2025-01-01T00:00:00.000Z' as ClassWithRemaining['createdAt'],
    remaining: 4,
  };
  return { ...base, ...overrides };
}

type Getter = (path: string) => Promise<unknown>;

/**
 * Fake `get` answering the two reads of the page: the classes, and the
 * member's own reservations (none unless given).
 */
function routes(
  classes: () => Promise<unknown>,
  reservations: () => Promise<unknown> = () => Promise.resolve({ items: [], nextCursor: null }),
): Getter {
  return (path) => (path.startsWith('/v1/reservations/me') ? reservations() : classes());
}

/** Minimal fake client; individual tests override `get` and `post`. */
function buildFakeClient(overrides?: { get?: Getter; post?: ApiClient['post'] }): ApiClient & {
  readonly get: ReturnType<typeof vi.fn>;
  readonly post: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(overrides?.get ?? (() => new Promise(() => undefined))),
    post: vi.fn(overrides?.post),
    patch: vi.fn(),
    del: vi.fn(),
  } as unknown as ApiClient & {
    readonly get: ReturnType<typeof vi.fn>;
    readonly post: ReturnType<typeof vi.fn>;
  };
}

/** Render, then flush the microtask queue so the fetch effect resolves. */
async function renderAndSettle(ui: ReactElement): Promise<void> {
  await act(async () => {
    renderWithLocale(ui);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<ClassesList />', () => {
  it('renders the loading state initially', () => {
    const client = buildFakeClient();
    renderWithLocale(<ClassesList client={client} t={t} />);

    // Loading state renders skeleton placeholders, no interactive buttons.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a card for each class of the selected day', async () => {
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
        startsAt: at(0, 19, 45),
      }),
    ];
    const client = buildFakeClient({ get: routes(() => Promise.resolve({ items })) });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText('CrossFit')).toBeDefined();
    expect(screen.getByText('Yoga')).toBeDefined();
    // Both CTAs are rendered — aria-label includes the class title.
    const ctas = screen.getAllByRole('button', {
      name: (n) => n.startsWith(t('classes.card.book')),
    });
    expect(ctas.length).toBe(2);
    expect(screen.getByRole('tabpanel')).toBeDefined();
  });

  it('shows the empty-state message when items is empty', async () => {
    const client = buildFakeClient({ get: routes(() => Promise.resolve({ items: [] })) });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText(t('classes.list.empty'))).toBeDefined();
  });

  it('shows an error + retry button when the fetch rejects', async () => {
    const client = buildFakeClient({ get: () => Promise.reject(new Error('network down')) });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText(t('errors.generic'))).toBeDefined();
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeDefined();
  });

  it('still lists the classes when the reservations read fails', async () => {
    const client = buildFakeClient({
      get: routes(
        () => Promise.resolve({ items: [klass({})] }),
        () => Promise.reject(new Error('network down')),
      ),
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(
      screen.getByRole('button', { name: (n) => n.startsWith(t('classes.card.book')) }),
    ).toBeDefined();
  });

  it('shows the classes the member already holds as booked or waitlisted', async () => {
    const booked = klass({ title: 'CrossFit' });
    const waitlisted = klass({
      id: '33333333-3333-4333-8333-333333333333' as ClassWithRemaining['id'],
      title: 'Yoga',
      remaining: 0,
      startsAt: at(0, 19, 45),
    });
    const reservation = (classId: string, status: string): Record<string, unknown> => ({
      id: `reservation-${classId}`,
      classId,
      userId: 'user-1',
      status,
      createdAt: '2026-10-01T09:00:00.000Z',
      cancelledAt: null,
      checkedInAt: null,
      class: { id: classId, title: 'x', startsAt: booked.startsAt, durationMin: 60 },
    });
    const client = buildFakeClient({
      get: routes(
        () => Promise.resolve({ items: [booked, waitlisted] }),
        () =>
          Promise.resolve({
            items: [reservation(booked.id, 'confirmed'), reservation(waitlisted.id, 'waitlist')],
            nextCursor: null,
          }),
      ),
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    expect(screen.getByText(t('classes.card.booked'))).toBeDefined();
    expect(screen.getByText(t('classes.card.onWaitlist'))).toBeDefined();
    expect(
      screen.queryByRole('button', { name: (n) => n.startsWith(t('classes.card.book')) }),
    ).toBeNull();
  });

  it('optimistically takes a seat on click, then states and announces the booking on 201', async () => {
    const item = klass({ remaining: 4 });
    const client = buildFakeClient({
      get: routes(() => Promise.resolve({ items: [item] })),
      post: vi.fn().mockResolvedValue({
        status: 'confirmed',
        reservation: {},
      }) as unknown as ApiClient['post'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);

    // Pre-click: 8 of 12 seats taken.
    expect(screen.getByText('8 sur 12 prises')).toBeDefined();

    const cta = screen.getByRole('button', {
      name: (n) => n.startsWith(t('classes.card.book')),
    });
    await act(async () => {
      fireEvent.click(cta);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Post-click: one more seat taken, and it stayed taken.
    expect(screen.getByText('9 sur 12 prises')).toBeDefined();
    expect(screen.getByText(t('classes.card.booked'))).toBeDefined();
    // Success toast fired, and the polite live region says the same.
    expect(toastMock.success).toHaveBeenCalledWith(t('reservations.confirmed'));
    expect(screen.getByRole('status').textContent).toBe(t('reservations.confirmed'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');

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

  it('states the waitlist position returned on 202', async () => {
    const item = klass({ remaining: 0 });
    const client = buildFakeClient({
      get: routes(() => Promise.resolve({ items: [item] })),
      post: vi.fn().mockResolvedValue({
        status: 'waitlist',
        reservation: {},
        position: 2,
      }) as unknown as ApiClient['post'],
    });

    await renderAndSettle(<ClassesList client={client} t={t} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: (n) => n.startsWith(t('classes.card.joinWaitlist')) }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(t('classes.card.waitlistPosition', { position: 2 }))).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe(
      t('reservations.waitlistPosition', { position: 2 }),
    );
  });

  it('reverts the optimistic decrement and shows error on 422 class_in_past', async () => {
    const item = klass({ remaining: 4 });
    const client = buildFakeClient({
      get: routes(() => Promise.resolve({ items: [item] })),
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

    // Decrement reverted: back to 8 of 12 taken.
    expect(screen.getByText('8 sur 12 prises')).toBeDefined();
    // Error surfaced on the card.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(t('errors.classInPast'));
  });

  describe('week strip', () => {
    const tomorrow = klass({
      id: '44444444-4444-4444-8444-444444444444' as ClassWithRemaining['id'],
      title: 'Pilates',
      startsAt: at(1, 7),
    });
    const nextWeek = klass({
      id: '55555555-5555-4555-8555-555555555555' as ClassWithRemaining['id'],
      title: 'Spinning',
      startsAt: at(8, 18),
    });

    async function renderStrip(items: ClassWithRemaining[]): Promise<void> {
      const client = buildFakeClient({ get: routes(() => Promise.resolve({ items })) });
      await renderAndSettle(<ClassesList client={client} t={t} />);
    }

    it('shows seven days with today marked, opening on the first day with a class', async () => {
      await renderStrip([tomorrow, nextWeek]);

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(7);
      expect(tabs[0]?.getAttribute('aria-current')).toBe('date');
      expect(tabs[0]?.textContent).toContain(t('classes.week.today'));
      expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByText('Pilates')).toBeDefined();
      expect(screen.queryByText('Spinning')).toBeNull();
    });

    it('is a single tab stop moved by the arrow keys', async () => {
      await renderStrip([klass({}), tomorrow]);

      const tabs = (): HTMLElement[] => screen.getAllByRole('tab');
      expect(tabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
      expect(tabs()[0]?.tabIndex).toBe(0);

      tabs()[0]?.focus();
      fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'ArrowRight' });

      expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
      expect(tabs()[1]?.tabIndex).toBe(0);
      expect(tabs()[0]?.tabIndex).toBe(-1);
      expect(document.activeElement).toBe(tabs()[1]);
      expect(screen.getByText('Pilates')).toBeDefined();

      fireEvent.keyDown(tabs()[1] as HTMLElement, { key: 'ArrowLeft' });
      expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');

      fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'End' });
      expect(tabs()[6]?.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByText(t('classes.list.dayEmpty'))).toBeDefined();
    });

    it('pages to the next week and offers the next day with classes from an empty day', async () => {
      await renderStrip([klass({}), nextWeek]);

      fireEvent.click(screen.getAllByRole('tab')[2] as HTMLElement);
      expect(screen.getByText(t('classes.list.dayEmpty'))).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: t('classes.list.nextDay') }));
      expect(screen.getByText('Spinning')).toBeDefined();
      expect(screen.getAllByRole('tab')[1]?.getAttribute('aria-selected')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: t('classes.week.previous') }));
      expect(screen.getByText('CrossFit')).toBeDefined();
      expect(
        (screen.getByRole('button', { name: t('classes.week.previous') }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
});
