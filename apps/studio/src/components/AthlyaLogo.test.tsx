import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AthlyaLogo } from './AthlyaLogo';

describe('AthlyaLogo', () => {
  it('renders an accessible lockup by default', () => {
    render(<AthlyaLogo />);
    const logo = screen.getByRole('img', { name: 'Athlya' });
    expect(logo.getAttribute('viewBox')).not.toBe('0 0 100 100');
  });

  it('renders the mascot alone on a square grid', () => {
    render(<AthlyaLogo variant="mascot" height={48} />);
    const logo = screen.getByRole('img', { name: 'Athlya' });
    expect(logo.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(logo.getAttribute('height')).toBe('48');
  });

  it('gives each instance its own eye mask id', () => {
    const { container } = render(
      <>
        <AthlyaLogo />
        <AthlyaLogo />
      </>,
    );
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });
});
