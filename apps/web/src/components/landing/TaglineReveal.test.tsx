/**
 * Component tests for `<TaglineReveal />`: the heading keeps its full text
 * for assistive technology, stays at full colour under reduced motion, and
 * only arms the word-by-word reveal when motion is allowed.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaglineReveal } from './TaglineReveal';

const TEXT = 'Tes séances, tes données.';

function stubMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: reduced && query.includes('reduce'), media: query })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<TaglineReveal />', () => {
  it('renders the whole sentence as one heading, one span per word', () => {
    stubMotion(true);
    render(<TaglineReveal id="tagline" text={TEXT} />);
    const heading = screen.getByRole('heading', { level: 2, name: TEXT });
    expect(heading.querySelectorAll('.landing-word')).toHaveLength(4);
  });

  it('leaves the words at full colour when reduced motion is requested', () => {
    stubMotion(true);
    render(<TaglineReveal id="tagline" text={TEXT} />);
    expect(screen.getByRole('heading', { level: 2 }).hasAttribute('data-armed')).toBe(false);
  });

  it('arms the reveal when motion is allowed', () => {
    stubMotion(false);
    render(<TaglineReveal id="tagline" text={TEXT} />);
    expect(screen.getByRole('heading', { level: 2 }).hasAttribute('data-armed')).toBe(true);
  });
});
