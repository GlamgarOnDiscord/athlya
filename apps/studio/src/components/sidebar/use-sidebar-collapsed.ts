// Mirrored in apps/web/src/components/sidebar/use-sidebar-collapsed.ts: keep the code in both copies identical.

import { useCallback, useSyncExternalStore } from 'react';

/** localStorage key holding `'1'` (collapsed) or `'0'` (expanded). */
export const SIDEBAR_COLLAPSED_KEY = 'athlya.sidebar.collapsed';

const CHANGE_EVENT = 'athlya:sidebar-collapsed';

// Fallback when storage throws (private mode, blocked site data): the
// choice then lives for the current page only.
let memoryValue = false;

function read(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return memoryValue;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * Collapsed state of the desktop sidebar, persisted in localStorage and
 * shared by every mounted sidebar (and other tabs, through `storage`).
 * The server render is always expanded.
 */
export function useSidebarCollapsed(): readonly [boolean, (next: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const setCollapsed = useCallback((next: boolean) => {
    memoryValue = next;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable: `read` falls back to `memoryValue`.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [collapsed, setCollapsed];
}
