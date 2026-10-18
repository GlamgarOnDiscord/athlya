import { Text } from 'react-native';

import type { ReactNode } from 'react';

export interface AppTextProps {
  readonly children: ReactNode;
  /** `title` is announced as a heading by VoiceOver and TalkBack. */
  readonly variant?: 'title' | 'body' | 'muted';
  readonly className?: string;
}

const VARIANT_CLASSES = {
  title: 'text-3xl font-bold text-foreground dark:text-dark-foreground',
  body: 'text-base text-foreground dark:text-dark-foreground',
  muted: 'text-sm text-muted-foreground dark:text-dark-muted-foreground',
} as const;

export function AppText({ children, variant = 'body', className = '' }: AppTextProps) {
  return (
    <Text
      {...(variant === 'title' ? { accessibilityRole: 'header' as const } : {})}
      className={`${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </Text>
  );
}
