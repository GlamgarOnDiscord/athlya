'use client';

import {
  CheckCircleIcon,
  CircleNotchIcon,
  InfoIcon,
  WarningIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
// Static stylesheet: the CSP refuses the `<style>` sonner would inject at
// runtime, and the patch in `patches/` removes that injection.
import 'sonner/dist/styles.css';

const Toaster = ({ theme: _ignored, ...props }: ToasterProps) => {
  const { theme: systemTheme } = useTheme();
  const theme: 'system' | 'light' | 'dark' =
    systemTheme === 'light' || systemTheme === 'dark' || systemTheme === 'system'
      ? systemTheme
      : 'system';

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <WarningOctagonIcon className="size-4" />,
        loading: <CircleNotchIcon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
