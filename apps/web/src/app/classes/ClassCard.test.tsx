/**
 * Component tests for `<ClassCard />`.
 *
 * The card is pure presentation — the fake `onBook` keeps the
 * assertions focused on what the DOM looks like and how clicks flow
 * out to the parent. Four tests:
 *   1. Title, date/time, and remaining/capacity render.
 *   2. Clicking the primary CTA invokes `onBook(classInfo.id)`.
 *   3. When `remaining === 0` the button reads "Complet" and is
 *      disabled.
 *   4. The `role="alert"` slot surfaces when `error` is passed in.
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
  capacity: 12,
  remaining: 4,
};

afterEach(() => {
  cleanup();
});

describe('<ClassCard />', () => {
  it('renders title, start time, remaining and capacity', () => {
    render(<ClassCard classInfo={BASE_CLASS} t={t} locale="fr" onBook={vi.fn()} />);

    expect(screen.getByText('CrossFit')).toBeDefined();
    // Capacity line.
    expect(screen.getByText('12')).toBeDefined();
    // Remaining / capacity line — we assert the exact "4 / 12".
    expect(screen.getByText('4 / 12')).toBeDefined();
    // `<time>` tag carries the raw ISO datetime attribute.
    const time = screen.getByText((_, node) => node?.tagName.toLowerCase() === 'time');
    expect(time.getAttribute('datetime')).toBe(BASE_CLASS.startsAt);
  });

  it('calls onBook(classInfo.id) when the CTA is clicked', async () => {
    const onBook = vi.fn().mockResolvedValue(undefined);
    render(<ClassCard classInfo={BASE_CLASS} t={t} locale="fr" onBook={onBook} />);

    const cta = screen.getByRole('button', { name: t('classes.card.book') });
    await act(async () => {
      fireEvent.click(cta);
      await Promise.resolve();
    });

    expect(onBook).toHaveBeenCalledTimes(1);
    expect(onBook).toHaveBeenCalledWith('class-1');
  });

  it('renders "Complet" and disables the button when remaining is 0', () => {
    const onBook = vi.fn();
    render(
      <ClassCard classInfo={{ ...BASE_CLASS, remaining: 0 }} t={t} locale="fr" onBook={onBook} />,
    );

    const cta = screen.getByRole('button', {
      name: t('classes.card.full'),
    }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    expect(cta.textContent).toBe(t('classes.card.full'));
    // "Complet" buttons must not trigger onBook.
    fireEvent.click(cta);
    expect(onBook).not.toHaveBeenCalled();
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
