import { useEffect } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';

export interface NoticeProps {
  readonly message: string;
  readonly tone?: 'info' | 'error';
}

const TONE_CLASSES = {
  info: 'bg-muted dark:bg-dark-muted',
  error:
    'border border-destructive bg-background dark:border-dark-destructive dark:bg-dark-background',
} as const;

const TEXT_CLASSES = {
  info: 'text-foreground dark:text-dark-foreground',
  error: 'text-destructive dark:text-dark-destructive',
} as const;

/**
 * Status or error message announced to screen readers: through a live
 * region on Android, explicitly on iOS (which has no live regions).
 */
export function Notice({ message, tone = 'info' }: NoticeProps) {
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, [message]);

  return (
    <View
      accessible
      accessibilityRole={tone === 'error' ? 'alert' : 'text'}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      className={`rounded-md px-md py-sm ${TONE_CLASSES[tone]}`}
    >
      <Text className={`text-sm ${TEXT_CLASSES[tone]}`}>{message}</Text>
    </View>
  );
}
