import { View } from 'react-native';

import type { ReactNode } from 'react';

export interface CardProps {
  readonly children: ReactNode;
}

/**
 * Visual grouping only: the card is not an accessibility element, so the
 * text, fields and buttons inside stay individually reachable. Give a card
 * a heading as its first child when it needs a name.
 */
export function Card({ children }: CardProps) {
  return (
    <View className="gap-sm rounded-lg border border-border bg-background p-md dark:border-dark-border dark:bg-dark-background">
      {children}
    </View>
  );
}
