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
      return state.pending > 0
        ? { message: { key: 'mobile.sync.offline', values: { count: state.pending } } }
        : null;
    case 'auth-required':
      return { message: { key: 'mobile.sync.authRequired', values: { count: state.pending } } };
    case 'idle':
      return state.deadLetters > 0
        ? { message: { key: 'mobile.sync.rejected', values: { count: state.deadLetters } } }
        : null;
  }
}
