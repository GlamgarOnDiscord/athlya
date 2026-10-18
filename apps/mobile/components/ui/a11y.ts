/**
 * Accessibility props for the interactive primitives (Requirement 27.3).
 * Kept free of React Native imports so the contract is unit-tested in Node.
 */
import type { SyncState } from '../../infrastructure/sync/sync-controller';

export interface ButtonA11yInput {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
}

export interface ButtonA11yProps {
  readonly accessible: true;
  readonly accessibilityRole: 'button';
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly accessibilityState: { readonly disabled: boolean; readonly busy: boolean };
}

export function buttonA11yProps(input: ButtonA11yInput): ButtonA11yProps {
  if (input.label.trim() === '') {
    throw new Error('Interactive primitives require a non-empty accessibility label');
  }
  return {
    accessible: true,
    accessibilityRole: 'button',
    accessibilityLabel: input.label,
    ...(input.hint === undefined ? {} : { accessibilityHint: input.hint }),
    accessibilityState: {
      disabled: input.disabled === true || input.busy === true,
      busy: input.busy === true,
    },
  };
}

export type SyncBannerMessage =
  | { readonly key: 'mobile.sync.syncing'; readonly values: { processed: number; total: number } }
  | { readonly key: 'mobile.sync.offline'; readonly values: { count: number } }
  | { readonly key: 'mobile.sync.authRequired'; readonly values: { count: number } }
  | { readonly key: 'mobile.sync.rejected'; readonly values: { count: number } };

export interface SyncBannerModel {
  readonly message: SyncBannerMessage;
  /** Present while a drain runs, for the `progressbar` role. */
  readonly progress?: { readonly min: 0; readonly max: number; readonly now: number };
}

/** What the sync banner shows, or `null` when there is nothing to report. */
export function syncBannerModel(state: SyncState): SyncBannerModel | null {
  switch (state.status) {
    case 'syncing':
      return {
        message: {
          key: 'mobile.sync.syncing',
          values: { processed: state.processed, total: state.total },
        },
        progress: { min: 0, max: state.total, now: state.processed },
      };
    case 'offline':
      if (state.pending > 0) {
        return { message: { key: 'mobile.sync.offline', values: { count: state.pending } } };
      }
      return state.deadLetters > 0
        ? { message: { key: 'mobile.sync.rejected', values: { count: state.deadLetters } } }
        : null;
    case 'auth-required':
      return { message: { key: 'mobile.sync.authRequired', values: { count: state.pending } } };
    case 'idle':
      return state.deadLetters > 0
        ? { message: { key: 'mobile.sync.rejected', values: { count: state.deadLetters } } }
        : null;
  }
}

function requireLabel(label: string): void {
  if (label.trim() === '') {
    throw new Error('Interactive primitives require a non-empty accessibility label');
  }
}

export interface TextFieldA11yInput {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | null | undefined;
}

export interface TextFieldA11yProps {
  readonly accessible: true;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
}

/**
 * Text inputs carry their visible label as the accessibility label; a
 * validation error is read first in the hint, so a screen-reader user
 * hears what to fix when focusing the field.
 */
export function textFieldA11yProps(input: TextFieldA11yInput): TextFieldA11yProps {
  requireLabel(input.label);
  const hint = [input.error ?? undefined, input.hint].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  return {
    accessible: true,
    accessibilityLabel: input.label,
    ...(hint.length === 0 ? {} : { accessibilityHint: hint.join('. ') }),
  };
}

export interface SwitchA11yInput extends ButtonA11yInput {
  readonly checked: boolean;
}

export interface SwitchA11yProps {
  readonly accessible: true;
  readonly accessibilityRole: 'switch';
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly accessibilityState: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly busy: boolean;
  };
}

export function switchA11yProps(input: SwitchA11yInput): SwitchA11yProps {
  requireLabel(input.label);
  return {
    accessible: true,
    accessibilityRole: 'switch',
    accessibilityLabel: input.label,
    ...(input.hint === undefined ? {} : { accessibilityHint: input.hint }),
    accessibilityState: {
      checked: input.checked,
      disabled: input.disabled === true || input.busy === true,
      busy: input.busy === true,
    },
  };
}
