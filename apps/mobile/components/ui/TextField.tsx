import { colors } from '@athlya/shared/tokens';
import { Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';

import { textFieldA11yProps } from './a11y';

export interface TextFieldProps {
  /** Visible label, also the accessibility label. */
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly hint?: string;
  /** Validation message shown under the field and read in its hint. */
  readonly error?: string | null;
  readonly secureTextEntry?: boolean;
  readonly keyboardType?: TextInputProps['keyboardType'];
  readonly autoComplete?: TextInputProps['autoComplete'];
  readonly autoCapitalize?: TextInputProps['autoCapitalize'];
  readonly textContentType?: TextInputProps['textContentType'];
  readonly multiline?: boolean;
  readonly editable?: boolean;
  readonly maxLength?: number;
}

export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  secureTextEntry,
  keyboardType,
  autoComplete,
  autoCapitalize = 'none',
  textContentType,
  multiline,
  editable = true,
  maxLength,
}: TextFieldProps) {
  const theme = useColorScheme() === 'dark' ? colors.dark : colors.light;
  const a11y = textFieldA11yProps({ label, hint, error });
  const invalid = error !== undefined && error !== null;
  return (
    <View className="gap-xs">
      <Text
        importantForAccessibility="no"
        className="text-sm font-semibold text-foreground dark:text-dark-foreground"
      >
        {label}
      </Text>
      <TextInput
        {...a11y}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        placeholderTextColor={theme.mutedForeground}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        {...(secureTextEntry === undefined ? {} : { secureTextEntry })}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        {...(autoComplete === undefined ? {} : { autoComplete })}
        {...(textContentType === undefined ? {} : { textContentType })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(multiline === true ? { multiline: true, textAlignVertical: 'top' as const } : {})}
        className={`min-h-12 rounded-md border px-md text-base text-foreground dark:text-dark-foreground ${invalid ? 'border-destructive dark:border-dark-destructive' : 'border-border dark:border-dark-border'} ${multiline === true ? 'min-h-24 py-sm' : ''}`}
      />
      {hint === undefined ? null : (
        <Text
          importantForAccessibility="no"
          className="text-xs text-muted-foreground dark:text-dark-muted-foreground"
        >
          {hint}
        </Text>
      )}
      {invalid ? (
        <Text
          importantForAccessibility="no"
          className="text-sm text-destructive dark:text-dark-destructive"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
