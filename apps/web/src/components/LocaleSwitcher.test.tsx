/**
 * Component tests for `<LocaleSwitcher />`.
 *
 * Three cases, enough to prove the contract without over-testing:
 *  1. The switcher renders both options under a `<LocaleProvider>`.
 *  2. The compact top-bar variant shows the code and keeps both options.
 *  3. Selecting a new locale writes `athlya.locale=<v>` to
 *     `document.cookie` with the expected attributes.
 *
 * We avoid spying on `window.location.reload` — jsdom surfaces that
 * as a "Not implemented" warning, and the cookie assertion is
 * sufficient to prove the state change propagated.
 *
 * @see Req 28.3 — user can switch between FR and EN.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../lib/i18n/LocaleContext';

import { LocaleSwitcher } from './LocaleSwitcher';

import type { ReactElement } from 'react';

/** Wrap the switcher in its required provider. */
function renderWithLocale(locale: 'fr' | 'en', compact = false): ReactElement {
  return render(
    <LocaleProvider locale={locale}>
      <LocaleSwitcher compact={compact} />
    </LocaleProvider>,
  ).container as unknown as ReactElement;
}

describe('<LocaleSwitcher />', () => {
  // Stub `window.location.reload` to the no-op jsdom forgets to
  // provide. Kept as a spy so the tests could assert on it later,
  // though we don't need to in this file.
  let reloadSpy: ReturnType<typeof vi.fn>;
  /** Latest cookie assignment captured by the setter. */
  let cookieAssignments: string[];

  beforeEach(() => {
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy },
    });

    cookieAssignments = [];
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => cookieAssignments.join('; '),
      set: (value: string) => {
        cookieAssignments.push(value);
      },
    });
  });

  afterEach(() => {
    // Tear down the rendered tree so each test starts with a
    // clean DOM — `render` does not auto-clean under Vitest
    // without `@testing-library/react`'s globals setup, so we
    // invoke it explicitly.
    cleanup();

    // Restore a plain string-backed `document.cookie` so other
    // tests (if any) don't inherit our interceptor.
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      writable: true,
      value: '',
    });
  });

  it('renders both locale options with the current value selected', () => {
    renderWithLocale('fr');

    const select = screen.getByLabelText('Locale') as HTMLSelectElement;
    expect(select.value).toBe('fr');

    // Both options are present regardless of which is currently selected.
    expect(screen.getByRole('option', { name: 'Français' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'English' })).toBeDefined();
  });

  it('shows the two-letter code in compact mode and keeps the full names in the list', () => {
    renderWithLocale('en', true);

    const select = screen.getByLabelText('Locale') as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect(select.className).toContain('opacity-0');
    expect(screen.getByText('en').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('option', { name: 'Français' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'English' })).toBeDefined();
  });

  it('writes athlya.locale cookie on change', () => {
    renderWithLocale('fr');

    const select = screen.getByLabelText('Locale') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'en' } });

    expect(cookieAssignments.length).toBe(1);
    const written = cookieAssignments[0] ?? '';
    expect(written).toContain('athlya.locale=en');
    expect(written).toContain('path=/');
    // 1 year = 31_536_000 seconds.
    expect(written).toContain('max-age=31536000');
    // Reload is invoked after the cookie write so the server side
    // picks up the new locale.
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
