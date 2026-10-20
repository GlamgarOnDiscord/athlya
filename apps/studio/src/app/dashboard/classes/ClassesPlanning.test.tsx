/**
 * Component tests for the planning calendar: classes land in the cell of
 * their local start day, and clicks open edit or a prefilled create.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../../lib/i18n/t';

import { ClassesPlanning, type ClassesPlanningProps } from './ClassesPlanning';
import { fromDayKey } from './planning-grid';

import type { ClassWithRemaining } from '@athlya/shared/schemas/api';

const previousTz = process.env['TZ'];
process.env['TZ'] = 'Europe/Paris';

afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = previousTz;
});

afterEach(() => {
  cleanup();
});

const t = createTranslator('en');

function cls(id: string, title: string, startsAt: string, remaining = 4): ClassWithRemaining {
  return {
    id: id as ClassWithRemaining['id'],
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ClassWithRemaining['studioId'],
    coachId: null,
    title,
    startsAt,
    durationMin: 60,
    capacity: 12,
    remaining,
    version: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
  };
}

const BOXING = cls('c1', 'Boxing technique', '2026-10-20T16:30:00.000Z');
const YOGA = cls('c2', 'Sunday yoga', '2026-10-25T09:00:00.000Z', 0);

function renderPlanning(overrides: Partial<ClassesPlanningProps> = {}) {
  const props: ClassesPlanningProps = {
    view: 'week',
    anchor: fromDayKey('2026-10-21'),
    todayKey: '2026-10-20',
    items: [BOXING, YOGA],
    busy: false,
    locale: 'en',
    t,
    onSelectClass: vi.fn(),
    onCreateAt: vi.fn(),
    onShowDay: vi.fn(),
    ...overrides,
  };
  const { container } = render(<ClassesPlanning {...props} />);
  const day = (key: string): HTMLElement => {
    const cell = container.querySelector<HTMLElement>(`[data-day="${key}"]`);
    if (cell === null) throw new Error(`no cell for ${key}`);
    return cell;
  };
  return { props, day };
}

describe('<ClassesPlanning /> week view', () => {
  it('renders each class in the column of its local start day', () => {
    const { day } = renderPlanning();
    expect(within(day('2026-10-20')).getByText('Boxing technique')).toBeDefined();
    expect(within(day('2026-10-25')).getByText('Sunday yoga')).toBeDefined();
    expect(within(day('2026-10-25')).getByText('Full')).toBeDefined();
    expect(within(day('2026-10-21')).queryByText('Boxing technique')).toBeNull();
  });

  it('marks today and positions blocks through CSS variables, not inline style attributes', () => {
    const { day } = renderPlanning();
    const header = screen.getAllByText('20').find((el) => el.closest('[aria-current="date"]'));
    expect(header).toBeDefined();
    const block = within(day('2026-10-20')).getByRole('button', { name: /Boxing technique/ });
    expect(block.style.getPropertyValue('--block-top')).toBe('78.125%');
    expect(block.style.getPropertyValue('--block-height')).toBe('6.25%');
  });

  it('opens edit on a class and a prefilled create on an empty hour slot', () => {
    const { props, day } = renderPlanning();
    fireEvent.click(within(day('2026-10-20')).getByRole('button', { name: /Boxing technique/ }));
    expect(props.onSelectClass).toHaveBeenCalledWith(BOXING);

    fireEvent.click(
      within(day('2026-10-22')).getByRole('button', {
        name: /^New class on Thursday, October 22\b.*09:00\sAM$/,
      }),
    );
    const created = vi.mocked(props.onCreateAt).mock.calls[0]?.[0];
    expect(created?.toISOString()).toBe('2026-10-22T07:00:00.000Z');
  });
});

describe('<ClassesPlanning /> month view', () => {
  it('renders classes in their day cell and creates at 09:00 on an empty day', () => {
    const { props, day } = renderPlanning({ view: 'month' });
    expect(within(day('2026-10-20')).getByText('Boxing technique')).toBeDefined();
    expect(within(day('2026-10-25')).getByText('Sunday yoga')).toBeDefined();
    expect(day('2026-09-28')).toBeDefined();
    expect(day('2026-11-01')).toBeDefined();

    fireEvent.click(within(day('2026-10-14')).getByRole('button', { name: /New class on/ }));
    const created = vi.mocked(props.onCreateAt).mock.calls[0]?.[0];
    expect(created?.toISOString()).toBe('2026-10-14T07:00:00.000Z');
  });

  it('collapses a busy day behind a "more" button that opens its week', () => {
    const busyDay = ['06:00', '07:00', '08:00', '09:00', '10:00'].map((time, i) =>
      cls(`b${i}`, `Session ${i}`, `2026-10-23T${time}:00.000Z`),
    );
    const { props, day } = renderPlanning({ view: 'month', items: busyDay });
    const cell = day('2026-10-23');
    expect(within(cell).getByText('Session 2')).toBeDefined();
    expect(within(cell).queryByText('Session 3')).toBeNull();
    fireEvent.click(within(cell).getByRole('button', { name: /\+2 more/ }));
    expect(props.onShowDay).toHaveBeenCalledTimes(1);
  });
});
