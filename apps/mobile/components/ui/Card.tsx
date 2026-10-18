import { View } from 'react-native';

import type { ReactNode } from 'react';

export interface CardProps {
  readonly children: ReactNode;
  /** Read by screen readers as the card's name when set. */
  readonly accessibilityLabel?: string;
}

export function Card({ children, accessibilityLabel }: CardProps) {
  return (
    <View
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      className="gap-sm rounded-lg border border-border bg-background p-md dark:border-dark-border dark:bg-dark-background"
    >
      {children}
    </View>
  );
}
