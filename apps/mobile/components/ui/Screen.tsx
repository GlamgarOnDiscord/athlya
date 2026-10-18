import { SafeAreaView } from 'react-native-safe-area-context';

import type { ReactNode } from 'react';

export interface ScreenProps {
  readonly children: ReactNode;
}

/** Safe-area root of every screen, painted with the theme background. */
export function Screen({ children }: ScreenProps) {
  return (
    <SafeAreaView className="flex-1 gap-md bg-background p-lg dark:bg-dark-background">
      {children}
    </SafeAreaView>
  );
}
