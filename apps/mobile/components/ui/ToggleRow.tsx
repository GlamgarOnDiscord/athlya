import { Pressable, Switch, Text } from 'react-native';

import { switchA11yProps } from './a11y';

export interface ToggleRowProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly busy?: boolean;
}

/**
 * A labelled switch. The whole row is one accessible `switch` that toggles
 * on press (VoiceOver and TalkBack activate it with a double tap); the
 * native `Switch` inside is hidden from assistive technologies.
 */
export function ToggleRow({ label, hint, value, onValueChange, busy }: ToggleRowProps) {
  const a11y = switchA11yProps({ label, hint, busy, checked: value });
  const disabled = a11y.accessibilityState.disabled;
  return (
    <Pressable
      {...a11y}
      disabled={disabled}
      onPress={() => {
        onValueChange(!value);
      }}
      className="min-h-12 flex-row items-center justify-between gap-md"
    >
      <Text className="flex-1 text-base text-foreground dark:text-dark-foreground">{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      />
    </Pressable>
  );
}
