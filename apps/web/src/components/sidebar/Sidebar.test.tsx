/**
 * Component tests for `<SidebarShell />`: active route, disclosure
 * groups and the persisted collapsed state.
 */
import { HouseIcon, UserCircleIcon, UserIcon, TrashIcon } from '@phosphor-icons/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.fn(() => '/me/delete');

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

import { SidebarShell, type SidebarLabels } from './Sidebar';
import { SIDEBAR_COLLAPSED_KEY } from './use-sidebar-collapsed';

import type { SidebarSection } from './nav-model';

const labels: SidebarLabels = {
  navigation: 'Main navigation',
  collapse: 'Collapse sidebar',
  expand: 'Expand sidebar',
  openMenu: 'Open menu',
  closeMenu: 'Close menu',
  menu: 'Menu',
  skipToContent: 'Skip to content',
};

const sections: SidebarSection[] = [
  { id: 'main', items: [{ kind: 'link', href: '/classes', label: 'Classes', icon: HouseIcon }] },
  {
    id: 'account',
    items: [
      {
        kind: 'group',
        id: 'account',
        label: 'My account',
        icon: UserCircleIcon,
        children: [
          { kind: 'link', href: '/me', label: 'My profile', icon: UserIcon, match: 'exact' },
          { kind: 'link', href: '/me/delete', label: 'Delete my account', icon: TrashIcon },
        ],
      },
    ],
  },
];

function renderShell(): void {
  render(
    <SidebarShell sections={sections} labels={labels} brand={<span>Athlya</span>}>
      <main id="main-content">Page</main>
    </SidebarShell>,
  );
}

/** The desktop sidebar's navigation (the drawer is not mounted until opened). */
function desktopNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main navigation', hidden: true });
}

describe('<SidebarShell />', () => {
  beforeEach(() => {
    window.localStorage.clear();
    pathnameMock.mockReturnValue('/me/delete');
  });

  afterEach(() => {
    cleanup();
  });

  it('marks only the link of the current route with aria-current="page"', () => {
    renderShell();
    const nav = within(desktopNav());
    const current = nav.getByRole('link', { name: 'Delete my account', hidden: true });
    expect(current.getAttribute('aria-current')).toBe('page');
    // `/me` matches exactly, so it is not current on `/me/delete`.
    expect(
      nav.getByRole('link', { name: 'My profile', hidden: true }).getAttribute('aria-current'),
    ).toBeNull();
    expect(
      nav.getByRole('link', { name: 'Classes', hidden: true }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('opens the group holding the active route and toggles it as a disclosure', () => {
    renderShell();
    const toggle = within(desktopNav()).getByRole('button', { name: 'My account', hidden: true });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.hidden).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel?.hidden).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a group closed when none of its links is active', () => {
    pathnameMock.mockReturnValue('/classes');
    renderShell();
    const toggle = within(desktopNav()).getByRole('button', { name: 'My account', hidden: true });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('persists the collapsed state and restores it on the next render', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar', hidden: true }));
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    // Collapsed: groups close, labels stay as accessible names.
    const toggle = within(desktopNav()).getByRole('button', { name: 'My account', hidden: true });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      within(desktopNav()).getByRole('link', { name: 'Classes', hidden: true }),
    ).toBeDefined();

    cleanup();
    renderShell();
    const expand = screen.getByRole('button', { name: 'Expand sidebar', hidden: true });
    fireEvent.click(expand);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
    expect(screen.getByRole('button', { name: 'Collapse sidebar', hidden: true })).toBeDefined();
  });

  it('expands the sidebar and opens the group when a collapsed group is activated', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    pathnameMock.mockReturnValue('/classes');
    renderShell();
    fireEvent.click(
      within(desktopNav()).getByRole('button', { name: 'My account', hidden: true }),
    );
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
    expect(
      within(desktopNav())
        .getByRole('button', { name: 'My account', hidden: true })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('still toggles when localStorage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar', hidden: true }));
      expect(screen.getByRole('button', { name: 'Expand sidebar', hidden: true })).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar', hidden: true }));
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('opens the mobile drawer as a dialog with the same navigation', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu', hidden: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(
      within(dialog).getByRole('link', { name: 'Delete my account' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(within(dialog).getByRole('button', { name: 'Close menu' })).toBeDefined();
  });
});
