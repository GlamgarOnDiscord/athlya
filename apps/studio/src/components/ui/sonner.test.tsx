/**
 * The strict CSP refuses an unnonced `<style>`, so sonner must not inject
 * one at runtime: its rules come from the static `sonner/dist/styles.css`.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from './sonner';

beforeEach(() => {
  // jsdom has no matchMedia; sonner reads it for the system theme.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<Toaster />', () => {
  it('renders a toast without injecting a runtime <style> tag', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Saved');
    });

    expect(await screen.findByText('Saved')).toBeDefined();
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });
});
