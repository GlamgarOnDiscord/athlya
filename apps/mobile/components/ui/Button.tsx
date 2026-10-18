import { ActivityIndicator, Pressable, Text } from 'react-native';

import { buttonA11yProps } from './a11y';

export interface ButtonProps {
  /** Visible text; also the accessibility label unless `accessibilityLabel` is set. */
  readonly title: string;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly variant?: 'primary' | 'secondary';
}

const VARIANT_CLASSES = {
  primary: 'bg-primary dark:bg-dark-primary',
  secondary: 'bg-secondary dark:bg-dark-secondary',
} as const;

const LABEL_CLASSES = {
  primary: 'text-primary-foreground dark:text-dark-primary-foreground',
  secondary: 'text-foreground dark:text-dark-foreground',
} as const;

export function Button({
  title,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  busy,
  variant = 'primary',
}: ButtonProps) {
  const a11y = buttonA11yProps({
    label: accessibilityLabel ?? title,
    hint: accessibilityHint,
    disabled,
    busy,
  });
  return (
    <Pressable
      {...a11y}
      disabled={a11y.accessibilityState.disabled}
      onPress={onPress}
      hitSlop={8}
      className={`min-h-12 flex-row items-center justify-center rounded-lg px-lg ${VARIANT_CLASSES[variant]} ${a11y.accessibilityState.disabled ? 'opacity-50' : ''}`}
    >
      {busy === true ? (
        <ActivityIndicator importantForAccessibility="no" />
      ) : (
        <Text className={`text-base font-semibold ${LABEL_CLASSES[variant]}`}>{title}</Text>
      )}
    </Pressable>
  );
}
