import { colors, radii, spacing } from '@athlya/shared/tokens';
import { describe, expect, it } from 'vitest';

import { buttonA11yProps, syncBannerModel } from '../../components/ui/a11y';
import { resolveApiBaseUrl, resolveLocale } from '../../infrastructure/config';
import {
  loadOrCreateStorageKey,
  STORAGE_KEY_ITEM,
  toHex,
} from '../../infrastructure/storage/storage-key';
import { buildMobileTheme, toKebabCase } from '../../theme/preset';
import { FakeSecureStorage } from '../helpers';

import type { SyncState } from '../../infrastructure/sync/sync-controller';

const IDLE: SyncState = {
  status: 'idle',
  total: 0,
  processed: 0,
  pending: 0,
  deadLetters: 0,
  lastResult: null,
};

describe('theme preset', () => {
  it('maps every shared semantic color, light and dark', () => {
    const theme = buildMobileTheme();
    for (const [key, value] of Object.entries(colors.light)) {
      expect(theme.colors[toKebabCase(key)]).toBe(value);
    }
    for (const [key, value] of Object.entries(colors.dark)) {
      expect(theme.colors[`dark-${toKebabCase(key)}`]).toBe(value);
    }
    expect(theme.colors['primary-foreground']).toBe(colors.light.primaryForeground);
  });

  it('reuses the shared spacing and radii scales', () => {
    const theme = buildMobileTheme();
    expect(theme.spacing).toEqual(spacing);
    expect(theme.borderRadius).toEqual(radii);
  });
});

describe('buttonA11yProps', () => {
  it('exposes role, label, hint and state', () => {
    expect(buttonA11yProps({ label: 'Book', hint: 'Books the class', busy: true })).toEqual({
      accessible: true,
      accessibilityRole: 'button',
      accessibilityLabel: 'Book',
      accessibilityHint: 'Books the class',
      accessibilityState: { disabled: true, busy: true },
    });
  });

  it('refuses an empty label', () => {
    expect(() => buttonA11yProps({ label: '  ' })).toThrow(/label/u);
  });
});

describe('syncBannerModel', () => {
  it('shows progress while syncing', () => {
    expect(syncBannerModel({ ...IDLE, status: 'syncing', total: 50, processed: 32 })).toEqual({
      message: { key: 'mobile.sync.syncing', values: { processed: 32, total: 50 } },
      progress: { min: 0, max: 50, now: 32 },
    });
  });

  it('reports pending changes offline, auth issues and rejected changes', () => {
    expect(syncBannerModel({ ...IDLE, status: 'offline', pending: 3 })?.message.key).toBe(
      'mobile.sync.offline',
    );
    expect(syncBannerModel({ ...IDLE, status: 'auth-required', pending: 1 })?.message.key).toBe(
      'mobile.sync.authRequired',
    );
    expect(syncBannerModel({ ...IDLE, deadLetters: 2 })?.message.key).toBe('mobile.sync.rejected');
    expect(syncBannerModel({ ...IDLE, status: 'offline', deadLetters: 2 })?.message.key).toBe(
      'mobile.sync.rejected',
    );
  });

  it('stays hidden when there is nothing to report', () => {
    expect(syncBannerModel(IDLE)).toBeNull();
    expect(syncBannerModel({ ...IDLE, status: 'offline' })).toBeNull();
  });
});

describe('config', () => {
  it('defaults to production and accepts https origins', () => {
    expect(resolveApiBaseUrl('https://staging.api.athlya.app/')).toBe(
      'https://staging.api.athlya.app',
    );
  });

  it('refuses to fall back to production when the variable is missing', () => {
    expect(() => resolveApiBaseUrl(undefined)).toThrow(/not set/u);
    expect(() => resolveApiBaseUrl(' ')).toThrow(/not set/u);
  });

  it('allows plain http only for loopback development hosts', () => {
    expect(resolveApiBaseUrl('http://10.0.2.2:8787')).toBe('http://10.0.2.2:8787');
    expect(resolveApiBaseUrl('http://[::1]:8787')).toBe('http://[::1]:8787');
    expect(() => resolveApiBaseUrl('http://api.athlya.app')).toThrow(/https/u);
  });

  it('picks English for en-* and French otherwise', () => {
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('enochian')).toBe('fr');
    expect(resolveLocale('fr-FR')).toBe('fr');
    expect(resolveLocale('de-DE')).toBe('fr');
    expect(resolveLocale(undefined)).toBe('fr');
  });
});

describe('storage key', () => {
  it('creates the MMKV key once and reuses it', async () => {
    const secure = new FakeSecureStorage();
    let generated = 0;
    const generate = () => {
      generated += 1;
      return toHex(new Uint8Array([0, 15, 255, generated]));
    };

    const first = await loadOrCreateStorageKey(secure, generate);
    const second = await loadOrCreateStorageKey(secure, generate);

    expect(first).toBe('000fff01');
    expect(second).toBe(first);
    expect(generated).toBe(1);
    expect(secure.items.get(STORAGE_KEY_ITEM)).toBe(first);
  });
});
