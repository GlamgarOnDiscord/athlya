/**
 * Component tests for `<SeriesChart />`: accessible names, roving
 * keyboard focus and the screen-reader data table.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { niceMax, nextIndex, ticks } from './chart-utils';
import { SeriesChart, type SeriesDatum } from './SeriesChart';

const DATA: SeriesDatum[] = [
  { key: 'a', x: 1, value: 100, xLabel: '1 Oct', label: '1 Oct: 100 kg' },
  { key: 'b', x: 2, value: 250, xLabel: '2 Oct', label: '2 Oct: 250 kg' },
  { key: 'c', x: 3, value: 180, xLabel: '3 Oct', label: '3 Oct: 180 kg' },
];

function renderChart(kind: 'line' | 'bar' = 'line') {
  return render(
    <SeriesChart
      kind={kind}
      title="Volume — Squat"
      description="Daily volume"
      data={DATA}
      xDomain={[0, 4]}
      axisLabels={['1 Oct', '3 Oct']}
      formatValue={(v) => String(v)}
      tableHeaders={['Date', 'kg']}
      keyboardHint="Use the arrow keys"
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('<SeriesChart />', () => {
  it('names the figure and every data mark', () => {
    renderChart();
    expect(screen.getByRole('figure', { name: 'Volume — Squat' })).toBeDefined();
    for (const d of DATA) {
      expect(screen.getByRole('img', { name: d.label })).toBeDefined();
    }
  });

  it('exposes one tab stop, on the latest value', () => {
    renderChart();
    const marks = DATA.map((d) => screen.getByRole('img', { name: d.label }));
    expect(marks.map((m) => m.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it.each(['line', 'bar'] as const)(
    'moves focus with the arrow, Home and End keys (%s)',
    (kind) => {
      renderChart(kind);
      const last = screen.getByRole('img', { name: DATA[2]!.label });
      last.focus();
      fireEvent.keyDown(last, { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(screen.getByRole('img', { name: DATA[1]!.label }));
      fireEvent.keyDown(document.activeElement!, { key: 'Home' });
      expect(document.activeElement).toBe(screen.getByRole('img', { name: DATA[0]!.label }));
      fireEvent.keyDown(document.activeElement!, { key: 'End' });
      expect(document.activeElement).toBe(last);
      expect(last.getAttribute('tabindex')).toBe('0');
    },
  );

  it('shows a visible readout of the focused value', () => {
    const { container } = renderChart();
    act(() => {
      screen.getByRole('img', { name: DATA[1]!.label }).focus();
    });
    expect(container.querySelector('svg')?.textContent).toContain(DATA[1]!.label);
  });

  it('repeats every value in a data table for screen readers', () => {
    renderChart();
    const table = screen.getByRole('table', { name: 'Volume — Squat' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(DATA.length + 1);
    expect(within(table).getByRole('rowheader', { name: '2 Oct' })).toBeDefined();
    expect(within(table).getByRole('cell', { name: '250' })).toBeDefined();
  });
});

describe('chart-utils', () => {
  it('rounds the axis maximum up to a nice value', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(180)).toBe(200);
    expect(niceMax(2300)).toBe(2500);
  });

  it('spreads ticks from 0 to the maximum', () => {
    expect(ticks(200)).toEqual([0, 50, 100, 150, 200]);
  });

  it('clamps keyboard navigation to the data bounds', () => {
    expect(nextIndex('ArrowRight', 2, 3)).toBe(2);
    expect(nextIndex('ArrowLeft', 0, 3)).toBe(0);
    expect(nextIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextIndex('End', 0, 3)).toBe(2);
    expect(nextIndex('Enter', 1, 3)).toBeNull();
    expect(nextIndex('Home', 0, 0)).toBeNull();
  });
});
