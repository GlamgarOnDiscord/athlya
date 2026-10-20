'use client';

// Mirrored in apps/studio/src/components/sidebar/Sidebar.tsx: keep the code in both copies identical.
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { CaretDownIcon, ListIcon, SidebarSimpleIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useId, useState, type ReactElement, type ReactNode } from 'react';

import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import {
  isGroupActive,
  isLinkActive,
  type SidebarGroup,
  type SidebarLink,
  type SidebarSection,
} from './nav-model';
import { useSidebarCollapsed } from './use-sidebar-collapsed';

import type { Icon } from '@phosphor-icons/react';

/** Translated strings the shell renders around the navigation. */
export interface SidebarLabels {
  /** Accessible name of the `<nav>` landmark. */
  readonly navigation: string;
  readonly collapse: string;
  readonly expand: string;
  readonly openMenu: string;
  readonly closeMenu: string;
  /** Title of the mobile drawer dialog (visually hidden). */
  readonly menu: string;
  readonly skipToContent: string;
}

export interface SidebarShellProps {
  readonly sections: ReadonlyArray<SidebarSection>;
  /** Logo link shown at the top of the sidebar and of the mobile bar. */
  readonly brand: ReactNode;
  readonly labels: SidebarLabels;
  /** Bottom of the sidebar (account actions); receives the collapsed state. */
  readonly renderFooter?: (collapsed: boolean) => ReactNode;
  readonly children: ReactNode;
}

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring';

const itemBase = cn(
  'group/item relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors motion-reduce:transition-none',
  focusRing,
);

const idleItem = 'text-muted-foreground hover:bg-muted hover:text-foreground';
const activeItem = 'bg-muted text-foreground ring-1 ring-sidebar-border ring-inset';

/**
 * Label shown next to an icon-only item when the sidebar is collapsed.
 * The item keeps its accessible name through a visually hidden label, so
 * the tooltip itself is hidden from assistive technology. It shows on
 * hover and keyboard focus, stays while the pointer moves onto it (the
 * gap is padding, not margin) and Escape dismisses it.
 */
function SidebarTooltip({ label }: { readonly label: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="invisible absolute top-1/2 left-full z-50 -translate-y-1/2 pl-2 group-hover/item:visible group-focus-visible/item:visible group-data-[tips=off]/side:invisible!"
    >
      <span className="block rounded-md bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background">
        {label}
      </span>
    </span>
  );
}

function ItemLabel({
  label,
  collapsed,
}: {
  readonly label: string;
  readonly collapsed: boolean;
}): ReactElement {
  return (
    <span className={cn('min-w-0 flex-1 truncate text-left', collapsed && 'sr-only')}>{label}</span>
  );
}

export interface SidebarActionProps {
  readonly icon: Icon;
  readonly label: string;
  readonly collapsed: boolean;
  readonly onClick: () => void;
}

/** A footer button styled like a navigation item (sign out, for example). */
export function SidebarAction({
  icon: ActionIcon,
  label,
  collapsed,
  onClick,
}: SidebarActionProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(itemBase, idleItem, collapsed && 'justify-center px-0')}
    >
      <ActionIcon className="size-[18px] shrink-0" aria-hidden="true" />
      <ItemLabel label={label} collapsed={collapsed} />
      {collapsed ? <SidebarTooltip label={label} /> : null}
    </button>
  );
}

interface NavLinkItemProps {
  readonly link: SidebarLink;
  readonly pathname: string;
  readonly collapsed: boolean;
  readonly nested?: boolean;
  readonly onNavigate?: (() => void) | undefined;
}

function NavLinkItem({
  link,
  pathname,
  collapsed,
  nested = false,
  onNavigate,
}: NavLinkItemProps): ReactElement {
  const active = isLinkActive(pathname, link);
  const LinkIcon = link.icon;
  const Anchor = link.fullReload === true ? 'a' : Link;
  return (
    <Anchor
      href={link.href}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate?.()}
      className={cn(
        itemBase,
        active ? activeItem : idleItem,
        nested && 'h-8 gap-2.5 px-2',
        collapsed && 'justify-center px-0',
      )}
    >
      <LinkIcon
        className={cn('shrink-0', nested ? 'size-4' : 'size-[18px]')}
        weight={active ? 'fill' : 'regular'}
        aria-hidden="true"
      />
      <ItemLabel label={link.label} collapsed={collapsed} />
      {collapsed ? <SidebarTooltip label={link.label} /> : null}
    </Anchor>
  );
}

interface NavGroupItemProps {
  readonly group: SidebarGroup;
  readonly pathname: string;
  readonly collapsed: boolean;
  readonly open: boolean;
  readonly panelId: string;
  readonly onToggle: () => void;
  readonly onNavigate?: (() => void) | undefined;
}

function NavGroupItem({
  group,
  pathname,
  collapsed,
  open,
  panelId,
  onToggle,
  onNavigate,
}: NavGroupItemProps): ReactElement {
  const childActive = isGroupActive(pathname, group);
  const GroupIcon = group.icon;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn(
          itemBase,
          idleItem,
          childActive && 'text-foreground',
          collapsed && 'justify-center px-0',
          collapsed && childActive && activeItem,
        )}
      >
        <GroupIcon
          className="size-[18px] shrink-0"
          weight={collapsed && childActive ? 'fill' : 'regular'}
          aria-hidden="true"
        />
        <ItemLabel label={group.label} collapsed={collapsed} />
        {collapsed ? (
          <SidebarTooltip label={group.label} />
        ) : (
          <CaretDownIcon
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
        )}
      </button>
      <ul
        id={panelId}
        hidden={!open}
        className="mt-0.5 ml-[1.1rem] flex flex-col gap-0.5 border-l border-sidebar-border pl-2"
      >
        {group.children.map((child) => (
          <li key={child.href}>
            <NavLinkItem
              link={child}
              pathname={pathname}
              collapsed={false}
              nested
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

interface SidebarNavProps {
  readonly sections: ReadonlyArray<SidebarSection>;
  readonly label: string;
  readonly collapsed: boolean;
  /** Called when a collapsed group is activated: the sidebar expands first. */
  readonly onExpand?: () => void;
  readonly onNavigate?: (() => void) | undefined;
}

function SidebarNav({
  sections,
  label,
  collapsed,
  onExpand,
  onNavigate,
}: SidebarNavProps): ReactElement {
  const pathname = usePathname();
  const baseId = useId();
  // Explicit choices only; an untouched group is open when it holds the
  // active route.
  const [openGroups, setOpenGroups] = useState<Readonly<Record<string, boolean>>>({});

  return (
    <nav
      aria-label={label}
      className={cn('flex-1 px-3 py-2', collapsed ? 'overflow-visible' : 'overflow-y-auto')}
    >
      {sections.map((section, index) => (
        <Fragment key={section.id}>
          {index > 0 ? <hr className="my-3 border-sidebar-border" /> : null}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              if (item.kind === 'link') {
                return (
                  <li key={item.href}>
                    <NavLinkItem
                      link={item}
                      pathname={pathname}
                      collapsed={collapsed}
                      onNavigate={onNavigate}
                    />
                  </li>
                );
              }
              const open = !collapsed && (openGroups[item.id] ?? isGroupActive(pathname, item));
              return (
                <li key={item.id}>
                  <NavGroupItem
                    group={item}
                    pathname={pathname}
                    collapsed={collapsed}
                    open={open}
                    panelId={`${baseId}-${item.id}`}
                    onNavigate={onNavigate}
                    onToggle={() => {
                      if (collapsed) onExpand?.();
                      setOpenGroups((prev) => ({ ...prev, [item.id]: collapsed ? true : !open }));
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}

const iconButton = cn(
  'group/item relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none',
  focusRing,
);

/**
 * App shell with a collapsible sidebar on large screens and an
 * off-canvas drawer below `lg`. The drawer is the Base UI dialog the
 * `ui/dialog` primitives wrap: it traps focus, closes on Escape and
 * returns focus to the menu button.
 */
export function SidebarShell({
  sections,
  brand,
  labels,
  renderFooter,
  children,
}: SidebarShellProps): ReactElement {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tipsHidden, setTipsHidden] = useState(false);
  const closeDrawer = (): void => setDrawerOpen(false);

  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        {labels.skipToContent}
      </a>

      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground lg:hidden">
        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogTrigger
            render={<button type="button" className={iconButton} aria-label={labels.openMenu} />}
          >
            <ListIcon className="size-5" aria-hidden="true" />
          </DialogTrigger>
          <DialogPortal>
            <DialogOverlay className="bg-black/40 supports-backdrop-filter:backdrop-blur-none" />
            <DialogPrimitive.Popup
              data-slot="sidebar-drawer"
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[calc(100%-3rem)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground outline-none data-closed:animate-out data-closed:slide-out-to-left data-open:animate-in data-open:slide-in-from-left motion-reduce:animate-none"
            >
              <DialogTitle className="sr-only">{labels.menu}</DialogTitle>
              <div className="flex h-14 items-center justify-between gap-2 px-3">
                {brand}
                <DialogClose
                  render={
                    <button type="button" className={iconButton} aria-label={labels.closeMenu} />
                  }
                >
                  <XIcon className="size-5" aria-hidden="true" />
                </DialogClose>
              </div>
              <SidebarNav
                sections={sections}
                label={labels.navigation}
                collapsed={false}
                onNavigate={closeDrawer}
              />
              {renderFooter ? (
                <div className="border-t border-sidebar-border p-3">{renderFooter(false)}</div>
              ) : null}
            </DialogPrimitive.Popup>
          </DialogPortal>
        </Dialog>
        {brand}
      </header>

      <aside
        data-collapsed={collapsed ? 'true' : 'false'}
        data-tips={tipsHidden ? 'off' : 'on'}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setTipsHidden(true);
        }}
        onFocus={() => setTipsHidden(false)}
        onPointerLeave={() => setTipsHidden(false)}
        className={cn(
          'group/side sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 motion-reduce:transition-none lg:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-14 shrink-0 items-center gap-2 px-3',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {collapsed ? null : brand}
          <button
            type="button"
            className={iconButton}
            aria-label={collapsed ? labels.expand : labels.collapse}
            onClick={() => setCollapsed(!collapsed)}
          >
            <SidebarSimpleIcon className="size-[18px]" aria-hidden="true" />
            {collapsed ? <SidebarTooltip label={labels.expand} /> : null}
          </button>
        </div>
        <SidebarNav
          sections={sections}
          label={labels.navigation}
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
        />
        {renderFooter ? (
          <div className="border-t border-sidebar-border p-3">{renderFooter(collapsed)}</div>
        ) : null}
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
