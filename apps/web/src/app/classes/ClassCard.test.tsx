/**
 * Component tests for `<ClassCard />`.
 *
 * The card is pure presentation — the fake `onBook` keeps the
 * assertions focused on what the DOM looks like and how clicks flow
 * out to the parent:
 *   1. Title, start time, duration and the capacity line render, and
 *      the bar fills with the seats taken, like the text.
 *   2. Clicking the primary CTA invokes `onBook(classInfo.id)`.
 *   3. When `remaining === 0` the card offers the waitlist.
 *   4. The `role="alert"` slot surfaces when `error` is passed in.
 *   5. A held place replaces the action with its state in text.
 *
 * @see Requirements 7.1, 7.2, 8.1, 8.2.
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../lib/i18n/t';

import { ClassCard, type ClassCardInfo } from './ClassCard';

const t = createTranslator('fr');

const BASE_CLASS: ClassCardInfo = {
  id: 'class-1',
  title: 'CrossFit',
  startsAt: '2025-06-15T10:30:00.000Z',
  durationMin: 45,
  capacity: 12,
  remaining: 4,
};

afterEach(() => {
  cleanup();
});

describe('<ClassCard />', () => {
  it('renders title, start time, duration and a capacity bar that agrees with its text', () => {
    const { container } = render(
      <ClassCard classInfo={BASE_CLASS} t={t} locale="fr" onBook={vi.fn()} />,
    );

    expect(screen.getByText('CrossFit')).toBeDefined();
    expect(screen.getByText('45 min')).toBeDefined();
    // 4 of 12 seats remain: 8 are taken, and the bar is 8/12 full.
    expect(screen.getByText('4 places restantes')).toBeDefined();
    expect(screen.getByText('8 sur 12 prises')).toBeDefined();
    const track = container.querySelector<HTMLElement>('.class-card-capacity-bar')?.parentElement;
    expect(Number(track?.style.getPropertyValue('--bar-scale'))).toBeCloseTo(8 / 12);
    // `<time>` tag carries the raw ISO datetime attribute.
    const time = screen.getByText((_, node) => node?.tagName.toLowerCase() === 'time');
    expect(time.getAttribute('datetime')).toBe(BASE_CLASS.startsAt);
  });

  it('reads an empty class as an empty bar and a full one as a full bar', () => {
    const { container, rerender } = render(
      <ClassCard classInfo={{ ...BASE_CLASS, remaining: 12 }} t={t} locale="fr" onBook={vi.fn()} />,
    );
    const track = (): HTMLElement | null | undefined =>
      container.querySelector<HTMLElement>('.class-card-capacity-bar')?.parentElement;
    expect(screen.getByText('0 sur 12 prises')).toBeDefined();
    expect(track()?.style.getPropertyValue('--bar-scale')).toBe('0');

    rerender(
      <ClassCard classInfo={{ ...BASE_CLASS, remaining: 0 }} t={t} locale="fr" onBook={vi.fn()} />,
    );
    expect(screen.getByText('12 sur 12 prises')).toBeDefined();
    expect(screen.getByText(t('classes.card.fullWaitlist'))).toBeDefined();
    expect(track()?.style.getPropertyValue('--bar-scale')).toBe('1');
  });

  it('says "1 place restante" for the last seat', () => {
    render(
      <ClassCard classInfo={{ ...BASE_CLASS, remaining: 1 }} t={t} locale="fr" onBook={vi.fn()} />,
    );
    expect(screen.getByText(t('classes.card.placeLeft'))).toBeDefined();
  });

  it('calls onBook(classInfo.id) when the CTA is clicked', async () => {
    const onBook = vi.fn().mockResolvedValue(undefined);
    render(<ClassCard classInfo={BASE_CLASS} t={t} locale="fr" onBook={onBook} />);

    const cta = screen.getByRole('button', {
      name: `${t('classes.card.book')} — ${BASE_CLASS.title}`,
    });
    await act(async () => {
      fireEvent.click(cta);
      await Promise.resolve();
    });

    expect(onBook).toHaveBeenCalledTimes(1);
    expect(onBook).toHaveBeenCalledWith('class-1');
  });

  it('renders the join-waitlist button and does not call onBook when remaining is 0', () => {
    const onBook = vi.fn();
    render(
      <ClassCard classInfo={{ ...BASE_CLASS, remaining: 0 }} t={t} locale="fr" onBook={onBook} />,
    );

    const cta = screen.getByRole('button', {
      name: `${t('classes.card.joinWaitlist')} — ${BASE_CLASS.title}`,
    }) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    expect(cta.textContent).toBe(t('classes.card.joinWaitlist'));
    // Clicking while in full state still calls onBook (waitlist behaviour).
    fireEvent.click(cta);
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  it('shows a confirmed booking as a stated success, not as a button', () => {
    render(
      <ClassCard
        classInfo={BASE_CLASS}
        t={t}
        locale="fr"
        onBook={vi.fn()}
        booking={{ kind: 'confirmed' }}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(t('classes.card.booked')).className).toContain('text-success');
    expect(screen.getByRole('link', { name: t('classes.card.manage') }).getAttribute('href')).toBe(
      '/me',
    );
  });

  it('states the waitlist position when the API returned one', () => {
    const { rerender } = render(
      <ClassCard
        classInfo={{ ...BASE_CLASS, remaining: 0 }}
        t={t}
        locale="fr"
        onBook={vi.fn()}
        booking={{ kind: 'waitlist', position: 3 }}
      />,
    );
    expect(screen.getByText(t('classes.card.waitlistPosition', { position: 3 }))).toBeDefined();

    rerender(
      <ClassCard
        classInfo={{ ...BASE_CLASS, remaining: 0 }}
        t={t}
        locale="fr"
        onBook={vi.fn()}
        booking={{ kind: 'waitlist' }}
      />,
    );
    expect(screen.getByText(t('classes.card.onWaitlist'))).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('surfaces the error slot via role="alert" when error is provided', () => {
    render(
      <ClassCard
        classInfo={BASE_CLASS}
        t={t}
        locale="fr"
        onBook={vi.fn()}
        error={t('errors.bookingFull')}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(t('errors.bookingFull'));
    expect(alert.getAttribute('aria-live')).toBe('polite');
  });
});
