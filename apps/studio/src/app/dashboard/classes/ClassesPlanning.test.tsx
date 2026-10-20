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
    onDeleteClass: vi.fn(),
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
  const tile = (id: string): { button: HTMLElement; frame: HTMLElement } => {
    const button = container.querySelector<HTMLElement>(`button[data-class-id="${id}"]`);
    const frame = button?.closest<HTMLElement>('[data-full]');
    if (button === null || button === undefined || frame === null || frame === undefined) {
      throw new Error(`no tile for ${id}`);
    }
    return { button, frame };
  };
  return { props, day, tile };
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
    const { tile } = renderPlanning();
    const header = screen.getAllByText('20').find((el) => el.closest('[aria-current="date"]'));
    expect(header).toBeDefined();
    const block = tile('c1').frame;
    expect(block.style.getPropertyValue('--block-top')).toBe('78.125%');
    expect(block.style.getPropertyValue('--block-height')).toBe('6.25%');
  });

  it('opens edit on a class and a prefilled create on an empty hour slot', () => {
    const { props, day, tile } = renderPlanning();
    fireEvent.click(tile('c1').button);
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

describe('<ClassesPlanning /> short blocks and full markers', () => {
  it('collapses a 30-minute class to its title and keeps the rest in the accessible name', () => {
    const short = { ...cls('s1', 'Core blast', '2026-10-22T07:00:00.000Z'), durationMin: 30 };
    const { tile } = renderPlanning({ items: [short] });
    const { button, frame } = tile('s1');
    expect(frame.dataset['density']).toBe('compact');
    expect(within(button).getByText(/09:00 AM - 09:30 AM/).className).toContain('sr-only');
    expect(within(button).getByText(/4 left/).className).toContain('sr-only');
  });

  it('lets a full class title win the month cell, with the state kept for assistive tech', () => {
    const { day } = renderPlanning({ view: 'month' });
    const button = within(day('2026-10-25')).getByRole('button', { name: /Sunday yoga/ });
    expect(button.dataset['full']).toBe('true');
    expect(within(button).queryByText('Full')).toBeNull();
    expect(within(button).getByText(/Full/).className).toContain('sr-only');
  });
});

describe('<ClassesPlanning /> day agenda', () => {
  it('lists the anchor day and moves through its week strip', () => {
    const { props, day } = renderPlanning({ view: 'day', anchor: fromDayKey('2026-10-20') });
    expect(within(day('2026-10-20')).getByText('Boxing technique')).toBeDefined();
    expect(screen.queryByText('Sunday yoga')).toBeNull();

    const sunday = screen.getByRole('button', { name: 'Sunday, October 25' });
    expect(sunday.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sunday);
    expect(vi.mocked(props.onShowDay).mock.calls[0]?.[0].getDate()).toBe(25);

    fireEvent.click(screen.getByRole('button', { name: /^New class on Tuesday, October 20$/ }));
    expect(vi.mocked(props.onCreateAt).mock.calls[0]?.[0].toISOString()).toBe(
      '2026-10-20T07:00:00.000Z',
    );
  });
});

describe('<ClassesPlanning /> tiles', () => {
  it('shows the seats left in a volt pill on an open tile', () => {
    const { tile } = renderPlanning();
    const { button, frame } = tile('c1');
    expect(frame.dataset['full']).toBe('false');
    expect(frame.className).toContain('bg-muted');
    expect(within(button).getByText('4 left').className).toContain('planning-pill-open');
  });

  it('quiets a full class and gives it an ink "Full" pill when the tile has room', () => {
    const { tile } = renderPlanning();
    const { button, frame } = tile('c2');
    expect(frame.dataset['full']).toBe('true');
    expect(frame.className).toContain('text-muted-foreground');
    expect(within(button).getByText('Full').className).toContain('planning-pill-full');
  });

  it('drops the pill from a 45-minute tile but keeps the state for assistive tech', () => {
    const medium = { ...cls('m1', 'Spin', '2026-10-21T08:00:00.000Z', 0), durationMin: 45 };
    const { tile } = renderPlanning({ items: [medium] });
    const { button, frame } = tile('m1');
    expect(frame.dataset['density']).toBe('medium');
    expect(within(button).getByText(/Full/).className).toContain('sr-only');
    expect(within(frame).queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('offers edit and delete from the menu of a tall tile', async () => {
    const { props, tile } = renderPlanning();
    const trigger = within(tile('c1').frame).getByRole('button', {
      name: 'Actions for Boxing technique',
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(props.onDeleteClass).toHaveBeenCalledWith(BOXING);
    expect(props.onSelectClass).not.toHaveBeenCalled();
  });
});
