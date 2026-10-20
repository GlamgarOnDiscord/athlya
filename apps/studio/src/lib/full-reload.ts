/**
 * Routes entered with a full document load instead of a client transition.
 *
 * The check-in kiosk is served with `Permissions-Policy: camera=(self)` and
 * every other route with `camera=()` (`next.config.ts`). A permissions policy
 * belongs to the document that was loaded, so a client-side transition from
 * another dashboard page would keep `camera=()` and the browser would refuse
 * the camera. Loading the route as a new document picks up its own policy
 * without widening the policy anywhere else.
 */
export const FULL_RELOAD_ROUTES: readonly string[] = ['/dashboard/checkin'];

/** True when `href` points at one of {@link FULL_RELOAD_ROUTES} or below it. */
export function needsFullReload(href: string): boolean {
  const path = href.split(/[?#]/u, 1)[0] ?? href;
  return FULL_RELOAD_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

/** Navigates to `href`: a full document load where the route needs one, `push` otherwise. */
export function navigateTo(href: string, push: (href: string) => void): void {
  if (needsFullReload(href)) {
    window.location.assign(href);
    return;
  }
  push(href);
}
