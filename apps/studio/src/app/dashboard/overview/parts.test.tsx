/**
 * Sparkline marks: an empty period draws no bar, so an empty current week
 * never shows as a lone outlined dash.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MiniBars } from './parts';

afterEach(() => {
  cleanup();
});

function bars(values: ReadonlyArray<number | null>): Element[] {
  const { container } = render(<MiniBars values={values} />);
  return [...container.querySelectorAll('.mark-bar')];
}

describe('<MiniBars />', () => {
  it('puts the accent on the current period when it has a value', () => {
    const marks = bars([2, 3, 1]);
    expect(marks.at(-1)?.classList.contains('mark-accent')).toBe(true);
    expect(marks.filter((m) => m.classList.contains('mark-accent'))).toHaveLength(1);
  });

  it('draws no bar for an empty period, the current one included', () => {
    const marks = bars([2, 0, 3, null, 0]);
    expect(marks).toHaveLength(2);
    expect(marks.some((m) => m.classList.contains('mark-accent'))).toBe(false);
  });
});
