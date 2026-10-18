import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ReactNode } from 'react';

export interface ScrollScreenProps {
  readonly children: ReactNode;
}

/** `Screen` for content taller than the viewport (lists, forms). */
export function ScrollScreen({ children }: ScrollScreenProps) {
  return (
    <SafeAreaView className="flex-1 bg-background dark:bg-dark-background">
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-md p-lg">{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}
