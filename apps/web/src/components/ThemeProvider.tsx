'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';

import type { ReactNode } from 'react';

interface ThemeProviderProps {
  /** Per-request CSP nonce (`x-nonce`), stamped on the next-themes inline script. */
  readonly nonce: string | undefined;
  readonly children: ReactNode;
}

/**
 * Light and dark mode through next-themes. The resolved theme lands as a
 * `.light` or `.dark` class on `<html>`, which the shared theme
 * (`@athlya/shared/theme.css`) reads; `system` follows the OS, the same
 * default as before the provider existed. `color-scheme` is left to the
 * stylesheet so native controls keep their current rendering.
 */
export function ThemeProvider({ nonce, children }: ThemeProviderProps): ReactNode {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      enableColorScheme={false}
      {...(nonce === undefined ? {} : { nonce })}
    >
      {children}
    </NextThemesProvider>
  );
}
