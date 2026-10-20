// Mirrored in apps/studio/src/components/sidebar/nav-model.ts: keep the code in both copies identical.

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
  /**
   * The route runs in its own document, for response headers that grant
   * what other pages must not keep (the check-in camera policy): a link
   * into it, and every link out of it, loads a new document.
   */
  readonly fullReload?: boolean;
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

/** Href of the `fullReload` link whose route holds `pathname`, or null. */
export function ownDocumentAt(
  sections: ReadonlyArray<SidebarSection>,
  pathname: string,
): string | null {
  for (const section of sections) {
    for (const item of section.items) {
      const links = item.kind === 'link' ? [item] : item.children;
      const owner = links.find((link) => link.fullReload === true && isLinkActive(pathname, link));
      if (owner !== undefined) return owner.href;
    }
  }
  return null;
}

/**
 * Whether following `link` from a page in the `current` own-document route
 * (null outside one) enters or leaves such a route, so it must load a new
 * document instead of a client transition.
 */
export function crossesDocument(current: string | null, link: SidebarLink): boolean {
  return (link.fullReload === true ? link.href : null) !== current;
}

/** Whether one of the group's links matches the current `pathname`. */
export function isGroupActive(pathname: string, group: SidebarGroup): boolean {
  return group.children.some((child) => isLinkActive(pathname, child));
}
