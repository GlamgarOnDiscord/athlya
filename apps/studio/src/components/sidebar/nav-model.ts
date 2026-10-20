// Mirrored in apps/web/src/components/sidebar/nav-model.ts: keep the code in both copies identical.

import type { Icon } from '@phosphor-icons/react';

/** A navigation entry that points at an existing route. */
export interface SidebarLink {
  readonly kind: 'link';
  readonly href: string;
  readonly label: string;
  readonly icon: Icon;
  /**
   * `exact` highlights the link on its own path only; `prefix` (default)
   * also on nested paths, so `/classes/123` keeps "Classes" active.
   */
  readonly match?: 'exact' | 'prefix';
}

/** A disclosure that groups related links under one heading. */
export interface SidebarGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly icon: Icon;
  readonly children: ReadonlyArray<SidebarLink>;
}

export type SidebarItem = SidebarLink | SidebarGroup;

/** Items rendered together; sections are separated by a rule. */
export interface SidebarSection {
  readonly id: string;
  readonly items: ReadonlyArray<SidebarItem>;
}

/** Whether `link` matches the current `pathname`. */
export function isLinkActive(pathname: string, link: SidebarLink): boolean {
  if (pathname === link.href) return true;
  return link.match !== 'exact' && pathname.startsWith(`${link.href}/`);
}

/** Whether one of the group's links matches the current `pathname`. */
export function isGroupActive(pathname: string, group: SidebarGroup): boolean {
  return group.children.some((child) => isLinkActive(pathname, child));
}
