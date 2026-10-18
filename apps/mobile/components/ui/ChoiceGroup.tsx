import { Pressable, Text, View } from 'react-native';

import { radioA11yProps } from './a11y';

export interface Choice<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

export interface ChoiceGroupProps<T extends string | number> {
  /** Name of the group, announced before its options. */
  readonly label: string;
  readonly hint?: string;
  readonly choices: readonly Choice<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/**
 * Single-choice chips: a `radiogroup` of `radio` options, each at least
 * 48 dp high, the selected one filled with the primary colour.
 */
export function ChoiceGroup<T extends string | number>({
  label,
  hint,
  choices,
  value,
  onChange,
}: ChoiceGroupProps<T>) {
  return (
    <View className="gap-xs">
      <Text className="text-sm font-semibold text-foreground dark:text-dark-foreground">
        {label}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        className="flex-row flex-wrap gap-sm"
      >
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              key={String(choice.value)}
              {...radioA11yProps({ label: choice.label, hint, selected })}
              onPress={() => {
                if (!selected) onChange(choice.value);
              }}
              hitSlop={4}
              className={`min-h-12 items-center justify-center rounded-lg border px-md ${
                selected
                  ? 'border-primary bg-primary dark:border-dark-primary dark:bg-dark-primary'
                  : 'border-border bg-background dark:border-dark-border dark:bg-dark-background'
              }`}
            >
              <Text
                className={`text-base ${
                  selected
                    ? 'font-semibold text-primary-foreground dark:text-dark-primary-foreground'
                    : 'text-foreground dark:text-dark-foreground'
                }`}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
