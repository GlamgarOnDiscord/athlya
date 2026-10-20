/**
 * Routes that run in their own document.
 *
 * The check-in kiosk is served with `Permissions-Policy: camera=(self)` and
 * every other route with `camera=()` (`next.config.ts`). A permissions policy
 * belongs to the document that was loaded, so a client-side transition keeps
 * the policy of the page it starts from: entering the kiosk that way leaves
 * the camera blocked, and leaving it that way keeps the camera allowed on a
 * page that must not have it. Any navigation that crosses the edge of such a
 * route, in either direction, loads a new document instead.
 */
export const FULL_RELOAD_ROUTES: readonly string[] = ['/dashboard/checkin'];

function pathOf(href: string): string {
  return href.split(/[?#]/u, 1)[0] ?? href;
}

/** The own-document route holding `href`, or null. */
export function ownDocumentRoute(href: string): string | null {
  const path = pathOf(href);
  return FULL_RELOAD_ROUTES.find((route) => path === route || path.startsWith(`${route}/`)) ?? null;
}

/** True when going from `fromPath` to `href` enters or leaves an own-document route. */
export function needsFullReload(href: string, fromPath: string): boolean {
  return ownDocumentRoute(href) !== ownDocumentRoute(fromPath);
}

/**
 * Navigates to `href`: a full document load when it crosses the edge of an
 * own-document route, `push` otherwise. `fromPath` defaults to the current
 * page.
 */
export function navigateTo(
  href: string,
  push: (href: string) => void,
  fromPath: string = window.location.pathname,
): void {
  if (needsFullReload(href, fromPath)) {
    window.location.assign(href);
    return;
  }
  push(href);
}
